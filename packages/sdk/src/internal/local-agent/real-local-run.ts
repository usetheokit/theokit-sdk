import { ConfigurationError } from "../../errors.js";
import type { SDKMessage } from "../../types/messages.js";
import type { Run, RunOperation, RunStatus } from "../../types/run.js";
import { type AgentLoopInputs, runAgentLoop } from "../agent-loop/loop.js";
import { anySignal } from "../concurrency/abort-utils.js";
import { withToolWhitelist } from "../concurrency/async-local-storage.js";
import {
  type InheritedCredentials,
  withInheritedSubAgentCredentials,
} from "../concurrency/subagent-credentials.js";
import { diagFailure } from "../diagnostics.js";
import { emitRunEvent } from "../emit-run-event.js";
import { FallbackLlmClient } from "../llm/fallback-client.js";
import { resolveProviderChain } from "../llm/router.js";
import { FixtureRunBase, prepareRunContext } from "../runtime/fixtures/fixture-run-base.js";
import type { FixtureScript } from "../runtime/fixtures/types.js";
import { registerRun } from "../runtime/registry/run-registry.js";
import { createTelemetry } from "../telemetry/tracer.js";
import { buildMcpMap, runOwnsMcpClients } from "./real-local-run-mcp.js";

export type { CreateRealLocalRunOptions } from "./real-local-run-options.js";

import type { CreateRealLocalRunOptions } from "./real-local-run-options.js";
import { mergeExplicitApiKey, resolveRunProvider } from "./real-local-run-provider.js";
import { buildRunToolCatalogInput, resolveInheritedCredentials } from "./real-local-run-tools.js";

export function createRealLocalRun(options: CreateRealLocalRunOptions): Run {
  const { userText, userImages, id, startTime } = prepareRunContext(options.message);
  const supported = new Set<RunOperation>(["stream", "wait", "cancel", "conversation"]);
  // The base Run class accepts a FixtureScript for shape; the real LLM run does
  // not REPLAY it (`buildLoopInputs` drives the real agent loop instead of
  // replaying events) — but result-metadata fields set here (SE3 `origin`) ARE
  // read back by `buildResult → applyScriptMetrics` and surface on RunResult.
  // So this is the run's result-metadata script, not a throwaway.
  const runScript: FixtureScript = {
    events: [],
    finalStatus: "running",
    cancellable: false,
    conversation: [],
    // SE3 — carry the turn's provenance so buildResult forwards it onto RunResult.origin.
    ...(options.sendOptions.origin !== undefined ? { origin: options.sendOptions.origin } : {}),
  };

  const handle = new RealLocalRun(
    {
      id,
      agentId: options.agentId,
      model: options.model,
      script: runScript,
      supportedOps: supported,
      startTime,
    },
    () => buildLoopInputs(options, id, userText, userImages),
    runOwnsMcpClients(options.agentOptions),
    resolveInheritedCredentials(options.agentOptions),
  );
  handle.bootstrap();
  registerRun(handle);
  return handle;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: spread-conditional builders for optional fields (systemPrompt, onStep, onDelta, priorMessages, memoryTools, customTools, pluginManager) are the canonical pattern for shaping AgentLoopInputs; splitting hurts readability.
function buildLoopInputs(
  options: CreateRealLocalRunOptions,
  runId: string,
  userText: string,
  userImages: import("../../types/run.js").SDKUserMessage["images"],
): AgentLoopInputs {
  // M1-2: per-send iteration ceiling. Validate at the boundary so an invalid
  // knob fails fast with a clear message instead of producing a degenerate budget.
  const maxIterations = options.sendOptions.maxIterations;
  if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
    throw new ConfigurationError(
      `SendOptions.maxIterations must be a positive integer, got ${maxIterations}`,
      { code: "invalid_max_iterations" },
    );
  }
  const { primary, effectiveModelId } = resolveRunProvider(options);
  const fallback = options.agentOptions.providers?.fallback;
  // M4: thread the single explicit `apiKey` into the pool for `primary` so an
  // explicitly-passed credential is used even without the matching env var.
  const apiKeys = mergeExplicitApiKey(
    options.agentOptions.providers?.apiKeys,
    primary,
    options.agentOptions.apiKey,
  );
  const credentialPoolStrategy = options.agentOptions.providers?.credentialPoolStrategy;
  // theokit#58 follow-up: the chat route may opt into leaked-dialect recovery.
  // Mirrors how `primary` derives from routes[0]; applied to the resolved chain.
  const extractToolCallsFromContent =
    options.agentOptions.providers?.routes?.[0]?.extractToolCallsFromContent;
  // SE2 — when the caller subscribed via `onRunEvent`, a 429 retry surfaces a
  // typed `rate_limit` RunEvent (the pool-aware client calls this before backing off).
  const rateLimitSink = options.sendOptions.onRunEvent;
  // #332 — the model's own endpoint, when it named one. Threaded here because this is the only
  // place that holds both the resolved `ModelSelection` and the router options.
  const modelBaseUrl = options.model?.url;
  const chain = resolveProviderChain({
    primary,
    ...(modelBaseUrl !== undefined ? { baseUrl: modelBaseUrl } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    ...(apiKeys !== undefined ? { apiKeys } : {}),
    ...(credentialPoolStrategy !== undefined ? { credentialPoolStrategy } : {}),
    ...(extractToolCallsFromContent === true ? { extractToolCallsFromContent: true } : {}),
    ...(rateLimitSink !== undefined
      ? {
          onRateLimit: (info: { attempt: number; retryAfterMs?: number }) =>
            emitRunEvent(rateLimitSink, { type: "rate_limit", ...info }),
        }
      : {}),
  });
  const llm =
    chain.length === 1 ? (chain[0] as (typeof chain)[number]) : new FallbackLlmClient(chain);
  return {
    agentId: options.agentId,
    runId,
    // issue #47: carry ModelSelection.params (the reasoning `thinking` param) into the loop so the
    // request can forward reasoning. The id is stripped/normalized above; params pass through as-is.
    model: {
      id: effectiveModelId,
      ...(options.model?.params !== undefined ? { params: options.model.params } : {}),
    },
    userMessage: userText,
    ...(userImages !== undefined ? { userImages } : {}),
    llm,
    mcp: buildMcpMap(options),
    hooks: options.hooks,
    shellCwd: options.workspaceCwd,
    shellSandbox: options.agentOptions.local?.sandboxOptions?.enabled === true,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.onStep !== undefined ? { onStep: options.onStep } : {}),
    ...(options.onDelta !== undefined ? { onDelta: options.onDelta } : {}),
    ...(options.sendOptions.toolChoice !== undefined
      ? { toolChoice: options.sendOptions.toolChoice }
      : {}),
    ...(options.sendOptions.activeTools !== undefined
      ? { activeTools: options.sendOptions.activeTools }
      : {}),
    // SE1 — resolve the run's permission mode: per-send wins over creation-time.
    ...((options.sendOptions.permissionMode ?? options.agentOptions.permissionMode) !== undefined
      ? {
          permissionMode: options.sendOptions.permissionMode ?? options.agentOptions.permissionMode,
        }
      : {}),
    ...(options.priorMessages !== undefined ? { priorMessages: options.priorMessages } : {}),
    ...(options.memoryTools !== undefined && options.memoryTools.length > 0
      ? { memoryTools: options.memoryTools }
      : {}),
    ...buildRunToolCatalogInput({
      agentOptions: options.agentOptions,
      sendOptions: options.sendOptions,
      pluginManager: options.pluginManager,
      personalityToolWhitelist: options.personalityToolWhitelist,
      agentId: options.agentId,
      personalityName: options.personalityName,
      subagents: options.subagents,
      effectiveModel: options.model,
    }),
    ...(options.pluginManager !== undefined ? { pluginManager: options.pluginManager } : {}),
    // D318 — forward SendOptions.signal to the agent loop so streamLlmTurn
    // can attach it to the LLM `fetch({ signal })` call.
    ...(options.sendOptions.signal !== undefined ? { signal: options.sendOptions.signal } : {}),
    // M7 — forward SendOptions.context to the loop so every tool handler receives
    // it on `ctx.context` (shared run config set once, e.g. projectRoot).
    ...(options.sendOptions.context !== undefined ? { context: options.sendOptions.context } : {}),
    // SE2 — forward the opt-in typed runtime-event sink to the loop.
    ...(options.sendOptions.onRunEvent !== undefined
      ? { runEventSink: options.sendOptions.onRunEvent }
      : {}),
    // #58 / #57 — forward the per-tool timeout + tool-result guard so a consumer
    // can enable them via SendOptions (not only internal AgentLoopInputs).
    ...(options.sendOptions.perToolTimeoutMs !== undefined
      ? { perToolTimeoutMs: options.sendOptions.perToolTimeoutMs }
      : {}),
    ...(options.sendOptions.toolResultGuard !== undefined
      ? { toolResultGuard: options.sendOptions.toolResultGuard }
      : {}),
    // M1-2: per-send iteration ceiling (validated above). The loop reads
    // inputs.maxIterations (default 8 when unset).
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    // Doom-loop guard config (default on; `false` disables, object tunes thresholds).
    ...(options.sendOptions.doomLoop !== undefined
      ? { doomLoop: options.sendOptions.doomLoop }
      : {}),
    // D315-D317 — tool lifecycle hooks (cost tracking + audit + retry/alert)
    ...(options.agentOptions.onToolStart !== undefined
      ? { onToolStart: options.agentOptions.onToolStart }
      : {}),
    ...(options.agentOptions.onToolEnd !== undefined
      ? { onToolEnd: options.agentOptions.onToolEnd }
      : {}),
    ...(options.agentOptions.onToolError !== undefined
      ? { onToolError: options.agentOptions.onToolError }
      : {}),
    telemetry: createTelemetry(options.agentOptions.telemetry),
    // SDK 2.0 Phase 2 / T2.1: thread the optional BudgetTracker from
    // Agent.create options down to the loop. Runtime `track()` / `check()`
    // calls land in a follow-up iteration; for now the field is plumbed
    // so future enablement requires no further type changes.
    ...(options.agentOptions.budgetTracker !== undefined
      ? { budgetTracker: options.agentOptions.budgetTracker }
      : {}),
    // SDK 2.0 Phase 1 / T1.4: thread the optional MemoryProvider from
    // Agent.create options down to the loop. Runtime `init()` /
    // `buildTools()` / `runActivePass()` / `dispose()` calls land in
    // T1.5; for now the field is plumbed so the runtime wiring requires
    // no further type changes.
    ...(options.agentOptions.memoryProvider !== undefined
      ? { memoryProvider: options.agentOptions.memoryProvider }
      : {}),
  };
}

class RealLocalRun extends FixtureRunBase {
  private readonly buildInputs: () => AgentLoopInputs;
  /** theokit#155 — whether this turn releases its MCP clients, or the session pool does. */
  private readonly ownsMcpClients: boolean;
  /** theokit#148 — what a delegated child inherits from this parent, scoped to the loop. */
  private readonly inheritedCredentials: InheritedCredentials;
  /**
   * B-495 — the run's own abort, composed into the signal the loop hands to the LLM fetch and the
   * tool executors, so `cancel()` stops the request and not only the status. A TypeScript `private`
   * field, never a JS `#private` one: the run wrappers are Proxies that call `cancel()` with `this`
   * bound to the Proxy, where reading a `#private` field throws.
   */
  private readonly cancelController = new AbortController();

  constructor(
    options: ConstructorParameters<typeof FixtureRunBase>[0],
    buildInputs: () => AgentLoopInputs,
    ownsMcpClients: boolean,
    inheritedCredentials: InheritedCredentials,
  ) {
    super(options);
    this.buildInputs = buildInputs;
    this.ownsMcpClients = ownsMcpClients;
    this.inheritedCredentials = inheritedCredentials;
  }

  bootstrap(): void {
    setTimeout(() => {
      void this.driveLoop();
    }, 0);
  }

  override cancel(): Promise<void> {
    // Repeats the base guard on purpose: a run that already finished keeps its request untouched
    // and its result (usage and cost included) as it was.
    if (this.terminated) return Promise.resolve();
    this.cancelController.abort();
    return super.cancel();
  }

  protected override notifyImmediately(): boolean {
    return true;
  }

  private async driveLoop(): Promise<void> {
    if (this.terminated) return;
    const inputs = this.tryBuildInputs();
    if (inputs === undefined) return;
    await this.initializeMcp(inputs);
    await this.executeAgentLoop(inputs);
  }

  private tryBuildInputs(): AgentLoopInputs | undefined {
    try {
      return this.buildInputs();
    } catch (cause) {
      this.emitErrorEvent(cause, "Failed to build agent loop inputs", "", "build_inputs_failed");
      this.transitionTo("error" satisfies RunStatus);
      return undefined;
    }
  }

  private async initializeMcp(inputs: AgentLoopInputs): Promise<void> {
    for (const [name, client] of inputs.mcp.entries()) {
      try {
        await client.initialize();
      } catch (cause) {
        this.emitErrorEvent(
          cause,
          `MCP server ${name} failed to initialize`,
          `MCP server ${name} failed to initialize: `,
          "mcp_init_failed",
        );
      }
    }
  }

  /**
   * theokit#140 - events already handed to stream() by the live subscriber.
   *
   * The loop still RETURNS its full event list, and that batch path is deliberately kept: it is the
   * fallback if a live event is ever lost, and removing it would make the live channel a single
   * point of failure for the whole transcript.
   */
  private readonly liveDelivered = new Set<SDKMessage>();

  private async executeAgentLoop(inputs: AgentLoopInputs): Promise<void> {
    // theokit#140 - subscribe BEFORE the loop runs, so nothing is missed between start and the
    // first await. Events now reach stream() in true order as they happen, instead of arriving as
    // one post-completion batch while onDelta streamed tokens on a separate clock.
    // theokit#140 - whether a text delta has crossed since the last assistant message was reported.
    // This is the FACT that lets the timeline say `textAlreadyStreamed` instead of leaving the
    // consumer to infer it by comparing text - the inference that produced the `callId`-namespace
    // and timestamp-fallback bugs. Scoped per run, reset at each assistant message so a multi-step
    // run answers the question per message rather than once for the whole run.
    let textStreamedSinceLastMessage = false;
    inputs.signal = anySignal([inputs.signal, this.cancelController.signal]);
    inputs.onLoopEvent = (event: SDKMessage) => {
      // B-495 — wait() resolved at cancel time; what the loop reports while it unwinds (its
      // "[aborted]" message, a late tool result) must not change what stream() and events() return.
      if (this.terminated) return;
      this.liveDelivered.add(event);
      this.script.events.push(event);
      // theokit#140 - the same event on the complete timeline. Both views are fed from the one
      // place the loop reports, so they cannot disagree about order or contents.
      const carriesText =
        event.type === "assistant" && event.message.content.some((b) => b.type === "text");
      this.pushTimeline(
        carriesText
          ? { kind: "message", message: event, textAlreadyStreamed: textStreamedSinceLastMessage }
          : // No text ⇒ the question does not apply. Marking a tool-only or structural message
            // would be a claim the consumer acts on by HIDING content it was never shown.
            { kind: "message", message: event },
      );
      if (carriesText) textStreamedSinceLastMessage = false;
      this.notifyNewEvents();
    };
    // theokit#140 - the OTHER half of the timeline. Deltas were only ever reachable through the
    // caller's own `onDelta`, which is why a consumer had to fuse two surfaces to see tokens and
    // tool calls in one order. The caller's callback is preserved and still fires first: this wraps
    // it, never replaces it.
    const callerOnDelta = inputs.onDelta;
    inputs.onDelta = (delta) => {
      // B-495 — a record already parsed when cancel() ran still travels up after the abort; a
      // terminal run hands no more deltas to the caller's onDelta or to the timeline.
      if (this.terminated) return;
      callerOnDelta?.(delta);
      if (delta.update.type === "text-delta") textStreamedSinceLastMessage = true;
      this.pushTimeline({ kind: "delta", update: delta.update });
    };
    try {
      // B-495 — cancelled while MCP servers initialized: start no turn. Inside the `try`, so the
      // `finally` below still closes the MCP clients this run owns.
      if (this.terminated) return;
      // SE18 — when the send set `activeTools`, run the loop inside a tool-whitelist
      // scope so a call to a tool outside the set is vetoed at dispatch (same path as
      // `Agent.fork`'s `allowedTools`). Absent ⇒ the full toolset is available.
      const runLoop = (): Promise<Awaited<ReturnType<typeof runAgentLoop>>> =>
        inputs.activeTools !== undefined
          ? withToolWhitelist(new Set(inputs.activeTools), () => runAgentLoop(inputs))
          : runAgentLoop(inputs);
      // theokit#148 — publish the parent's delegation credentials for the duration of the loop.
      // A subagent tool reads them at dispatch, so they survive every layer that rebuilds the tool
      // object (including the SDK's own rebuild in `real-local-run-tools.ts`), and two concurrent
      // runs sharing one tool instance each see their own.
      const output = await withInheritedSubAgentCredentials(this.inheritedCredentials, runLoop);
      this.applyAgentLoopOutput(output);
      this.transitionTo(output.finalStatus);
    } catch (cause) {
      this.emitErrorEvent(cause, "Agent loop failed", "", "agent_loop_failed");
      this.transitionTo("error" satisfies RunStatus);
    } finally {
      // theokit#155 — release only what this TURN owns. Under `mcpLifecycle: 'session'` the pool
      // owns the client and releases it via `disposeSessionMcpClients` (`LocalAgent.dispose()`) plus
      // `reapIdle` on the next acquire; closing it here would kill the child the next turn expects
      // to still be running.
      if (this.ownsMcpClients) await closeOwnedMcpClients(inputs);
    }
  }

  /**
   * Copy runAgentLoop output into the script (events + conversation +
   * usage/cost + errorDetail). Extracted to keep executeAgentLoop below
   * the complexity-10 cap (D422 / sdk-biome-cleanup-plan).
   *
   * D376/D377: usage/cost surfaced for RunResult.usage / RunResult.cost.
   * Finding-B fix (sdk-error-packaging v1.1): set-once errorDetail copy.
   */
  private applyAgentLoopOutput(output: Awaited<ReturnType<typeof runAgentLoop>>): void {
    // B-495 — a run cancelled mid-turn is already final; its output arrives after wait() resolved.
    if (this.terminated) return;
    this.deliverUndeliveredEvents(output.events);
    this.script.conversation.push(...output.conversation);
    if (output.result.length > 0) this.script.result = output.result;
    if (output.usage !== undefined) this.script.usage = output.usage;
    if (output.cost !== undefined) this.script.cost = output.cost;
    // M1-2 (T2.2): surface the silent-truncation signal onto the RunResult.
    if (output.stoppedAtIterationLimit === true) this.script.stoppedAtIterationLimit = true;
    // Doom-loop guard: surface the identical-repeat stop signal onto the RunResult.
    if (output.stoppedByDoomLoop === true) this.script.stoppedByDoomLoop = true;
    if (output.error !== undefined && this.script.errorDetail === undefined) {
      this.script.errorDetail = {
        message: output.error.message,
        ...(output.error.code !== undefined ? { code: output.error.code } : {}),
        cause: output.error.cause,
      };
    }
  }

  /**
   * theokit#140 - deliver only what the live subscriber has NOT already handed to `stream()`.
   *
   * The loop now reports each event as it happens, so this batch is the SAME list, replayed.
   * Without the guard every event would reach `stream()` twice: once live, once here.
   *
   * Identity, not deep equality: these are the very objects the live sink saw, and two genuinely
   * distinct events can be structurally identical (the same tool called twice with the same args
   * is not a duplicate).
   *
   * Extracted because the guard pushed `applyAgentLoopOutput` past the cognitive-complexity cap.
   */
  private deliverUndeliveredEvents(events: readonly SDKMessage[]): void {
    for (const event of events) {
      if (this.liveDelivered.has(event)) continue;
      this.script.events.push(event);
      this.notifyNewEvents();
    }
  }

  private emitErrorEvent(cause: unknown, fallback: string, prefix = "", code?: string): void {
    // Finding-B fix (sdk-error-packaging-fix-plan v1.1): surface infra
    // failures (MCP init, build-inputs, agent_loop_failed outer-catch) via
    // the structured `errorDetail` channel ONLY — never as assistant
    // content. Downstream `buildResult()` copies this onto RunResult.error,
    // and `Run.stream()` will emit a typed `{ type: "error" }` event when
    // the runtime observes errorDetail (Phase 2). Set-once.
    if (this.script.errorDetail === undefined) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const display = prefix.length > 0 ? `${prefix}${message}` : message || fallback;
      this.script.errorDetail = {
        message: display,
        ...(code !== undefined ? { code } : {}),
        cause,
      };
    }
    this.notifyNewEvents();
  }
}

/**
 * Close every MCP client a turn owns. A close that fails must not mask the turn's outcome, so it is
 * not rethrown, but it may leave the server's child process running, so it is reported with the
 * server's name. The `finally` of `executeAgentLoop` is the only place these clients are released,
 * including for a run cancelled while its servers initialized (B-495).
 */
async function closeOwnedMcpClients(inputs: AgentLoopInputs): Promise<void> {
  for (const [name, client] of inputs.mcp.entries()) {
    try {
      await client.close();
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      diagFailure(
        `[theokit-sdk] MCP server ${name} failed to close; its process may still be running: ${why}`,
      );
    }
  }
}
