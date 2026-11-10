import type { SDKMessage, SDKToolUseMessage } from "../../types/messages.js";
import type { InteractionUpdate } from "../../types/updates.js";
import { checkToolWhitelist } from "../concurrency/async-local-storage.js";
import { mapWithConcurrency } from "../concurrency/map-with-concurrency.js";
import { diag } from "../diagnostics.js";
import { emitRunEvent } from "../emit-run-event.js";
import { generateCallId } from "../ids.js";
import type { LlmContentPart, LlmToolCallPart } from "../llm/types.js";
import { HISTOGRAM_NAMES } from "../telemetry/span-names.js";
import { type RepairableTool, repairToolCall } from "../tool-dispatch/repair-middleware.js";
import { executeTool, renderToolResult, type ToolResult } from "./tool-executors.js";
import { raceToolExecution } from "./tool-timeout.js";
import type { AgentLoopInputs, ResolvedTool } from "./types.js";

export type { ResolvedTool } from "./types.js";

/**
 * T2.4 — Parallel tool dispatch with bounded concurrency (DR2 finding #4).
 *
 * Pre-T2.4 this was a serial `for...of` loop — each tool call awaited
 * before the next. With N independent tools each taking Tms, total
 * wall-clock was N×Tms. T2.4 switches to `Promise.all` with bounded
 * concurrency via an inline semaphore (ADR D135 — in-house, no
 * `p-limit` dep). Default cap is 4 concurrent tools; consumer
 * overrides via `AgentLoopInputs.maxConcurrentTools`.
 *
 * Order preservation: `Promise.all` preserves input order in the
 * resolved array regardless of which promise settles first — the
 * LLM expects tool results in call order and this contract holds.
 *
 * Event array safety: `events` is append-only. In single-threaded
 * JS (Node event loop), concurrent `.push()` calls from different
 * microtask continuations do NOT interleave — each push is atomic.
 * The order of events across tools becomes non-deterministic, but
 * each individual tool's events are internally ordered.
 */
export async function dispatchTools(
  inputs: AgentLoopInputs,
  tools: ResolvedTool[],
  toolCalls: LlmToolCallPart[],
  events: SDKMessage[],
  // M3 #64 — the run's agent.send span, so each tool.call span nests under it.
  parentSpan?: ToolSpan,
): Promise<LlmContentPart[]> {
  const maxConcurrent = inputs.maxConcurrentTools ?? 4;
  // A `sequential` MCP server's calls of one step form one unit that runs them in listed order;
  // every other call is its own unit. Units share the pool, so a held-back call never occupies a slot.
  type Unit = { indexes: number[] };
  const units: Unit[] = [];
  const bySequentialServer = new Map<string, Unit>();
  toolCalls.forEach((call, index) => {
    const tool = tools.find((t) => t.name === call.name);
    if (tool?.mcpSequential === true && tool.mcpServerName !== undefined) {
      let unit = bySequentialServer.get(tool.mcpServerName);
      if (unit === undefined) {
        unit = { indexes: [] };
        bySequentialServer.set(tool.mcpServerName, unit);
        units.push(unit);
      }
      unit.indexes.push(index);
    } else {
      units.push({ indexes: [index] });
    }
  });
  const results: LlmContentPart[] = new Array(toolCalls.length);
  // M0-2: consolidated onto the shared ordered bounded pool.
  await mapWithConcurrency(units, maxConcurrent, async (unit) => {
    for (const index of unit.indexes) {
      results[index] = await dispatchSingleCall(
        inputs,
        tools,
        toolCalls[index] as LlmToolCallPart,
        events,
        parentSpan,
      );
    }
  });
  return results;
}

/** M3 #64 — the OTel span type threaded for tool-span nesting. */
type ToolSpan = ReturnType<NonNullable<AgentLoopInputs["telemetry"]>["startSpan"]> | undefined;

/**
 * What every step of one tool call already needed.
 *
 * The seven-step decomposition below is what a previous audit's PV#2 produced by splitting a
 * 158-line `dispatchSingleCall`, and it is the right shape. Its cost was the parameter list: each
 * step re-declared the same four values — the loop inputs, the post-repair call, its id and the
 * event sink — so two steps sat at six parameters and every step's signature grew with the state
 * rather than with its own job.
 *
 * `call` is the WORKING call, after the D86-D88 repair middleware rewrote it. `callId` is minted
 * once per dispatch and identifies the call across the span, the events and both hooks.
 */
interface DispatchContext {
  readonly inputs: AgentLoopInputs;
  readonly call: LlmToolCallPart;
  readonly callId: string;
  readonly events: SDKMessage[];
  readonly parentSpan?: ToolSpan | undefined;
}

/**
 * T10.4 / PV#2 — `dispatchSingleCall` orchestrator split into named sub-steps.
 * Each step is a private function with a single concern; the orchestrator
 * sequences them. The previous complexity-suppression directive (over a
 * 158 LOC body with 5 origin branches inline) is no longer required after
 * the split.
 *
 * Step taxonomy:
 *  1. `applyRepairAndExtractCall` — ADRs D86-D88 repair middleware.
 *  2. `enforceForkWhitelist`      — ADR D111 fork tool-whitelist veto.
 *  3. `startToolCallSpan`         — OTel span init + repairs annotation.
 *  4. `runPluginPreToolVeto`      — ADR D101 plugin veto.
 *  5. `runFileHookPreToolVeto`    — operator-policy hook veto.
 *  6. `runToolWithLifecycle`      — exec + onToolStart/End/Error hooks.
 *  7. `finalizeSpanAndPostHook`   — span end + postToolUse + return shape.
 */
async function dispatchSingleCall(
  inputs: AgentLoopInputs,
  tools: ResolvedTool[],
  call: LlmToolCallPart,
  events: SDKMessage[],
  parentSpan?: ToolSpan,
): Promise<LlmContentPart> {
  const { call: workingCall, repairs } = applyRepairAndExtractCall(tools, call);
  const dc: DispatchContext = {
    inputs,
    call: workingCall,
    callId: generateCallId(),
    events,
    parentSpan,
  };

  const forkVeto = vetoFromForkWhitelist(dc);
  if (forkVeto !== undefined) return forkVeto;

  const resolved = tools.find((tool) => tool.name === workingCall.name);
  const toolSpan = startToolCallSpan(dc, resolved, repairs);
  events.push(buildToolUseRunning(dc));

  const pluginVeto = await vetoFromPluginPreHook(dc);
  if (pluginVeto !== undefined) {
    // T2.5 — end the span on veto so we don't leak open OTel spans.
    // Pre-T2.5 the span started at step 3 but veto returns at step 4/5
    // skipped step 7's `toolSpan.end()` — leaked an open span.
    toolSpan?.setAttribute("tool.vetoed", true);
    toolSpan?.setAttribute("tool.veto_source", "plugin");
    toolSpan?.end();
    return pluginVeto;
  }

  const fileVeto = await vetoFromFileHookPreDecision(dc);
  if (fileVeto !== undefined) {
    toolSpan?.setAttribute("tool.vetoed", true);
    toolSpan?.setAttribute("tool.veto_source", "file_hook");
    toolSpan?.end();
    return fileVeto;
  }

  // SE2 — all vetoes passed; the tool is about to dispatch. Emit tool_progress.
  emitRunEvent(inputs.runEventSink, {
    type: "tool_progress",
    toolName: workingCall.name,
    toolCallId: dc.callId,
  });
  const result = await runToolWithLifecycle(dc, resolved);
  // #65 — post_tool_call hook (previously dead) fires after each tool completes.
  await inputs.pluginManager?.runPostToolCallHooks({
    name: workingCall.name,
    args: workingCall.input,
    result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
    agentId: inputs.agentId,
    runId: inputs.runId,
  });
  return finalizeSpanAndPostHook(dc, result, toolSpan);
}

interface RepairedCallShape {
  call: LlmToolCallPart;
  repairs: ReadonlyArray<string>;
}

/**
 * Step 1 — D86-D88 repair middleware. Returns the (possibly rewritten) call
 * and the list of repairs applied (used later for span annotation).
 */
function applyRepairAndExtractCall(
  tools: ResolvedTool[],
  call: LlmToolCallPart,
): RepairedCallShape {
  const registryMap = buildRepairRegistry(tools);
  const repaired = repairToolCall({ name: call.name, args: call.input, id: call.id }, registryMap);
  if (repaired.repairs.length === 0) return { call, repairs: repaired.repairs };
  return {
    call: {
      ...call,
      name: repaired.call.name,
      input: (repaired.call.args ?? {}) as Record<string, unknown>,
    },
    repairs: repaired.repairs,
  };
}

/**
 * Step 2 — D111 fork whitelist gate. Fires BEFORE plugin/file hooks because
 * a fork's allowedTools set is the strictest contract. Returns the
 * early-return content part when blocked; `undefined` to continue.
 */
function vetoFromForkWhitelist(dc: DispatchContext): LlmContentPart | undefined {
  const { inputs, call, callId, events } = dc;
  const whitelistDecision = checkToolWhitelist(call.name);
  if (whitelistDecision.allowed) return undefined;
  // SE2 — fork-whitelist denial is also an observable permission_denied.
  emitRunEvent(inputs.runEventSink, {
    type: "permission_denied",
    toolName: call.name,
    toolCallId: callId,
    source: "fork_whitelist",
    message: whitelistDecision.reason ?? "tool not available in fork",
  });
  events.push(buildToolUseRunning(dc));
  events.push(
    buildToolUseCompleted(dc, {
      stdout: "",
      stderr: whitelistDecision.reason ?? "tool not available in fork",
      exitCode: 126,
    }),
  );
  return {
    type: "tool_result",
    toolUseId: call.id,
    content: `Tool blocked by fork whitelist: ${whitelistDecision.reason}`,
  };
}

/**
 * Step 3 — OTel span init + repairs/args annotation. Returns the span
 * handle (or `undefined` when telemetry is disabled) for later finalization.
 */
function startToolCallSpan(
  dc: DispatchContext,
  resolved: ResolvedTool | undefined,
  repairs: ReadonlyArray<string>,
): ToolSpan {
  const { inputs, call, callId, parentSpan } = dc;
  // M3 #64 — nest tool.call under the run's agent.send span (not a flat sibling).
  const toolSpan = inputs.telemetry?.startChildSpan(parentSpan, "tool.call", {
    "tool.name": call.name,
    "tool.origin": resolved?.origin ?? "unknown",
    callId,
  });
  if (repairs.length > 0 && toolSpan !== undefined) {
    toolSpan.setAttribute("tool.repairs", repairs.join("; "));
  }
  if (toolSpan !== undefined && inputs.telemetry?.includeContent === true) {
    toolSpan.addEvent("args", { input: JSON.stringify(call.input) });
  }
  return toolSpan;
}

/**
 * Step 4 — D101 plugin `pre_tool_call` veto. Plugins are author-supplied
 * (code-level safety) and fire BEFORE file hooks (operator policy).
 */
async function vetoFromPluginPreHook(dc: DispatchContext): Promise<LlmContentPart | undefined> {
  const { inputs, call, callId, events } = dc;
  const pluginVeto = await inputs.pluginManager?.runPreToolCallHooks({
    name: call.name,
    args: call.input,
    agentId: inputs.agentId,
    runId: inputs.runId,
    // SE1 — thread the run's permission mode so a PermissionPlugin gates per-run.
    ...(inputs.permissionMode !== undefined ? { permissionMode: inputs.permissionMode } : {}),
  });
  if (pluginVeto === undefined) return undefined;
  // SE2 — a plugin veto (e.g. the permission gate) is a runtime-observability
  // signal: emit a typed `permission_denied` event out-of-band.
  emitRunEvent(inputs.runEventSink, {
    type: "permission_denied",
    toolName: call.name,
    toolCallId: callId,
    source: "plugin",
    message: pluginVeto.message,
  });
  events.push(
    buildToolUseCompleted(dc, {
      stdout: "",
      stderr: pluginVeto.message,
      exitCode: 126,
    }),
  );
  return {
    type: "tool_result",
    toolUseId: call.id,
    content: `Plugin blocked this tool call: ${pluginVeto.message}`,
  };
}

/**
 * Step 5 — file-based hooks `preToolUse` decision. Denial is surfaced as a
 * regular `tool_result` (not `isError`) so the model can react in narrative;
 * marking it `isError` would short-circuit the agent loop, which is too
 * harsh for a policy denial.
 */
async function vetoFromFileHookPreDecision(
  dc: DispatchContext,
): Promise<LlmContentPart | undefined> {
  const { inputs, call, callId, events } = dc;
  const preDecision = await inputs.hooks.run({
    event: "preToolUse",
    tool: call.name,
    input: call.input,
    agentId: inputs.agentId,
    runId: inputs.runId,
  });
  if (!preDecision.blocked) return undefined;
  // SE2 — operator file-hook `preToolUse` denial is also an observable event.
  emitRunEvent(inputs.runEventSink, {
    type: "permission_denied",
    toolName: call.name,
    toolCallId: callId,
    source: "file_hook",
    message: preDecision.reason ?? "blocked by hook",
  });
  events.push(
    buildToolUseCompleted(dc, {
      stdout: "",
      stderr: preDecision.reason ?? "blocked by hook",
      exitCode: 126,
    }),
  );
  return {
    type: "tool_result",
    toolUseId: call.id,
    content: `Hook denied this tool call: ${preDecision.reason ?? "no reason given"}`,
  };
}

/**
 * Step 6 — exec + D315-D317 onToolStart/End/Error lifecycle. Fires
 * `onToolError` when stderr/exit signals failure; otherwise `onToolEnd`.
 * The `error` field passed to `onToolError` is ALWAYS an `Error` instance.
 */
async function runToolWithLifecycle(
  dc: DispatchContext,
  resolved: ResolvedTool | undefined,
): Promise<ToolResult> {
  const { inputs, call, callId } = dc;
  const startAt = Date.now();
  await safeEmitToolHook(inputs.onToolStart, {
    toolName: call.name,
    args: call.input,
    conversationId: inputs.agentId,
    callId,
  });
  // #47-followup — surface the tool call LIVE via onDelta, at its true chronological position
  // (BETWEEN LLM rounds, before the post-tool answer streams). Tool dispatch already runs here, so
  // emitting the lifecycle from onDelta lets a consumer render tool→result ahead of the round-2 text
  // without the bridge having to HOLD the answer. The run.stream() replay of the same call/result is
  // deduped by callId downstream, so this never double-renders.
  await emitToolLifecycleDelta(inputs, {
    type: "tool-call-started",
    callId,
    toolCall: { callId, name: call.name, args: call.input },
    modelCallId: callId,
  });
  // #58 — bound the tool by the run's cancellation signal + optional per-tool
  // timeout so a hung tool cannot wedge the loop and cancel interrupts it.
  const result = await raceToolExecution(executeTool(inputs, resolved, call), {
    signal: inputs.signal,
    timeoutMs: inputs.perToolTimeoutMs,
  });
  const durationMs = Date.now() - startAt;
  // #47-followup — the matching live `tool-call-completed`, carrying the rendered result so the
  // consumer shows the output at the correct position (before the answer). Same value the returned
  // `tool_result` content part uses, so the onDelta render matches the run.stream() render it dedups.
  await emitToolLifecycleDelta(inputs, {
    type: "tool-call-completed",
    callId,
    toolCall: {
      callId,
      name: call.name,
      args: call.input,
      result: result.content !== undefined ? result.content : renderToolResult(result),
    },
    modelCallId: callId,
  });
  // M3 #64 — emit the tool-call duration as a metric (was hook-only).
  inputs.telemetry?.recordHistogram(HISTOGRAM_NAMES.TOOL_CALL_DURATION_MS, durationMs, {
    "tool.name": call.name,
  });
  if (result.exitCode !== undefined && result.exitCode !== 0 && result.exitCode !== null) {
    await safeEmitToolHook(inputs.onToolError, {
      toolName: call.name,
      args: call.input,
      error: new Error(result.stderr || `tool exited with code ${result.exitCode}`),
      conversationId: inputs.agentId,
      callId,
      durationMs,
      attempt: 1,
    });
  } else {
    await safeEmitToolHook(inputs.onToolEnd, {
      toolName: call.name,
      args: call.input,
      // SE17 — when a `toModelOutput` split is active, observability gets the FULL
      // raw output (`appResult`), NOT the compact model-facing value. SE7 — a
      // block-returning handler has empty `stdout`; surface its structured content
      // to the hook instead of an empty string.
      result:
        result.appResult !== undefined
          ? result.appResult
          : result.content !== undefined
            ? result.content
            : result.stdout,
      conversationId: inputs.agentId,
      callId,
      durationMs,
    });
  }
  return result;
}

/**
 * Step 7 — finalize the OTel span, emit the `tool_use_completed` event,
 * fire the `postToolUse` hook fire-and-forget, and build the
 * `tool_result` content part returned to the agent loop.
 */
function finalizeSpanAndPostHook(
  dc: DispatchContext,
  result: ToolResult,
  toolSpan: ReturnType<NonNullable<AgentLoopInputs["telemetry"]>["startSpan"]> | undefined,
): LlmContentPart {
  const { inputs, call, events } = dc;
  toolSpan?.setAttribute("exitCode", result.exitCode ?? 0);
  if (toolSpan !== undefined && inputs.telemetry?.includeContent === true) {
    toolSpan.addEvent("result", { stdout: result.stdout.slice(0, 1000) });
  }
  toolSpan?.end();
  events.push(buildToolUseCompleted(dc, result));
  // T2.8 — postToolUse is fire-and-forget (runs AFTER the tool result
  // is captured, so a veto is meaningless). But errors must NOT be
  // silently swallowed — at minimum log WARN so operators know a hook
  // is misbehaving. Pre-T2.8 the bare `void` prefix lost errors entirely.
  inputs.hooks
    .run({
      event: "postToolUse",
      tool: call.name,
      input: call.input,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
        // SE7 — structured content (text + image blocks) when the handler
        // returned/threw blocks; absent for the string path.
        ...(result.content !== undefined ? { content: result.content } : {}),
      },
      agentId: inputs.agentId,
      runId: inputs.runId,
    })
    .catch((err: unknown) => {
      diag(
        `[theokit-sdk] postToolUse hook error (swallowed): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  return {
    type: "tool_result",
    toolUseId: call.id,
    // SE7 — structured content blocks (handler-returned or ToolError-carried)
    // are authoritative; otherwise the legacy string rendering.
    content: result.content !== undefined ? result.content : renderToolResult(result),
    ...(result.exitCode !== 0 && result.exitCode !== undefined ? { isError: true } : {}),
  };
}

/**
 * #47-followup — emit a tool-lifecycle `InteractionUpdate` (`tool-call-started` / `tool-call-completed`)
 * through `onDelta`, so the tool renders at its true stream position (between LLM rounds, before the
 * post-tool answer). Awaited + error-swallowed (mirrors the loop's `safeCall` around onDelta): a
 * throwing listener must never crash the agent loop. No-op when `onDelta` is unset.
 *
 * @internal
 */
async function emitToolLifecycleDelta(
  inputs: AgentLoopInputs,
  update: InteractionUpdate,
): Promise<void> {
  if (inputs.onDelta === undefined) return;
  try {
    await inputs.onDelta({ update });
  } catch (err) {
    diag(
      `[theokit-sdk] onDelta tool-lifecycle emit error (swallowed): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * D317 — fire-and-forget tool-lifecycle hook with error swallowed via
 * stderr warn. Single chokepoint so all three callbacks (start/end/error)
 * share the same hardening: a misbehaving listener cannot crash the agent
 * loop.
 *
 * @internal
 */
async function safeEmitToolHook<E>(
  callback: ((event: E) => void | Promise<void>) | undefined,
  event: E,
): Promise<void> {
  if (callback === undefined) return;
  try {
    await callback(event);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    diag(`[theokit-sdk] tool lifecycle hook threw: ${msg}\n`);
  }
}

function buildToolUseRunning({ inputs, callId, call }: DispatchContext): SDKToolUseMessage {
  return {
    type: "tool_call",
    agent_id: inputs.agentId,
    run_id: inputs.runId,
    call_id: callId,
    name: call.name,
    status: "running",
    args: call.input,
  };
}

/**
 * T4.1 helper: project the agent-loop's ResolvedTool[] into a registry
 * shape consumable by `repairToolCall`. Caller owns the Map lifetime
 * (rebuilt each dispatchSingleCall — O(tools.length) overhead is negligible
 * compared to the LLM round-trip).
 */
function buildRepairRegistry(tools: ResolvedTool[]): ReadonlyMap<string, RepairableTool> {
  const out = new Map<string, RepairableTool>();
  for (const t of tools) {
    out.set(t.name, { name: t.name, inputSchema: t.inputSchema });
  }
  return out;
}

function buildToolUseCompleted(
  { inputs, callId, call }: DispatchContext,
  result: ToolResult,
): SDKToolUseMessage {
  return {
    type: "tool_call",
    agent_id: inputs.agentId,
    run_id: inputs.runId,
    call_id: callId,
    name: call.name,
    status: "completed",
    args: call.input,
    result: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    },
  };
}
