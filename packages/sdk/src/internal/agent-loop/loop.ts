import type { ToolContextMessage } from "../../types/agent-prims.js";
import { IterationBudget } from "../budget/tracker/budget.js";
import type { LlmContentPart, LlmMessage, LlmThinkingPart, LlmToolCallPart } from "../llm/types.js";
import { safeCall } from "../runtime/system-prompt/safe-call.js";
import { validateResponse } from "../runtime/validation/validate-response.js";
import { evaluateBudgetGate } from "./budget-gate.js";
import { firstDoomLoopVerdict } from "./doom-loop-tracker.js";
import { initLoopContext, type LoopContext } from "./loop-context-init.js";
import { finalizeLoopOutput } from "./loop-finalize.js";
import { type LlmTurnOutput, streamLlmTurn } from "./loop-llm-stream.js";
import { recordThinkingOnSilentToolRound, thinkingStep } from "./loop-thinking-steps.js";
import { buildAssistantEvent, buildAssistantTurn } from "./message-builders.js";
import { dispatchTools } from "./tool-dispatch.js";
import { applyToolResultGuard } from "./tool-result-guard.js";
import type { AgentLoopInputs, AgentLoopOutput } from "./types.js";
import { accumulateUsage } from "./usage-and-cost.js";

/**
 * SE12 — flatten the running transcript to the read-only text projection tool
 * handlers receive on `ctx.messages`. Non-text parts (tool calls / results) are
 * dropped so a tool never sees raw wire parts or nested tool args.
 */
function projectToolContextMessages(messages: readonly LlmMessage[]): ToolContextMessage[] {
  const projected: ToolContextMessage[] = [];
  for (const m of messages) {
    const content = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    // Skip turns that project to empty text (a tool-only assistant turn or a
    // tool-result-only user turn) — the text projection has nothing to forward,
    // so a messageFilter never sees zero-content noise.
    if (content !== "") projected.push({ role: m.role, content });
  }
  return projected;
}

/**
 * The real agent loop. Given an LLM client, MCP clients, hooks, and a shell
 * runner, it drives the LLM-tool-LLM cycle until the model stops. All
 * intermediate states surface as `SDKMessage` events so the caller can
 * stream them through `Run.stream()`.
 *
 * @internal
 */

export type { AgentLoopInputs, AgentLoopOutput } from "./types.js";

/** T2.1 (ADR D93) — maximum number of bailout-nudge user messages to inject. */
const MAX_NUDGE_ATTEMPTS = 2;

/** M1-4 — maximum number of `stop`-hook feedback re-prompts (reflection ceiling), mirroring MAX_NUDGE_ATTEMPTS. */
export const MAX_STOP_FEEDBACK_ATTEMPTS = 2;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: what remains is the round trip itself — context build, LLM turn, tool dispatch, stop condition — deliberately co-located so the streaming contract reads linearly. The post-loop tail this used to cover (termination diagnosis, span stamping, usage/cost, memory flush) moved to finalizeLoopOutput: none of it runs during a turn, so it was never part of what this argues for. Measured 2026-09-01: 57 -> 34 cognitive, 123 -> 70 lines.
export async function runAgentLoop(inputs: AgentLoopInputs): Promise<AgentLoopOutput> {
  const sendSpan = inputs.telemetry?.startSpan("agent.send", {
    agentId: inputs.agentId,
    runId: inputs.runId,
    "model.id": inputs.model.id ?? "auto",
  });
  if (sendSpan !== undefined && inputs.telemetry?.includeContent === true) {
    sendSpan.addEvent("prompt", { content: inputs.userMessage });
  }
  let ctxRef: LoopContext | undefined;
  try {
    const ctx = await initLoopContext(inputs);
    ctxRef = ctx;
    // M3 #64 — expose the run span so child spans nest under it.
    ctx.sendSpan = sendSpan;
    // #65 — on_session_start hook (previously dead) fires once per run.
    await inputs.pluginManager?.runOnSessionStartHooks({
      agentId: inputs.agentId,
      runId: inputs.runId,
    });
    const budget =
      inputs.budget ?? new IterationBudget({ maxIterations: inputs.maxIterations ?? 8 });
    // M1-2 (T2.2): track the last turn's decision so we can tell a clean
    // `done` finish from a silent truncation at the iteration ceiling.
    let lastTurnDecision: "continue" | "done" | "error" | undefined;
    while (budget.shouldContinue()) {
      if (inputs.budgetTracker !== undefined) {
        // Fail-CLOSED gate: a tracker that throws denies the iteration
        // instead of silently proceeding past budget (arch-review L1).
        const decision = evaluateBudgetGate(inputs.budgetTracker);
        if (decision.allowed === false) {
          ctx.finalStatus = "error";
          if (decision.detail !== undefined) {
            ctx.error = { message: decision.detail, code: decision.reason ?? "budget" };
          }
          // M1-2 (T2.2): a pluggable tracker denying on its iteration ceiling is
          // the same "hit the iteration limit" event as the legacy IterationBudget
          // exhausting below — surface the same signal so a caller using
          // createCounterBudgetTracker({maxIterations}) detects it consistently.
          if (decision.reason === "iteration_limit") {
            ctx.stoppedAtIterationLimit = true;
          }
          break;
        }
      }
      const usingGrace = budget.remaining <= 0 && !budget.graceCallUsed;
      if (usingGrace) budget.useGraceCall();
      const decision = await runIteration(inputs, ctx);
      lastTurnDecision = decision;
      if (decision === "done") break;
      if (decision === "error") {
        ctx.finalStatus = "error";
        break;
      }
      budget.consume();
      // M1-1: advance the pluggable tracker's iteration counter once per turn
      // so trackers gating on maxIterations actually halt (the counter was dead
      // because nothing called this). Optional + non-throwing per the contract.
      inputs.budgetTracker?.nextIteration?.();
      // #58 — after a completed turn, stop before starting a new one if the run
      // was cancelled mid-round. The first turn always runs (its own abort UX,
      // "[aborted]", is produced inside runIteration); this only prevents a NEW
      // LLM turn after a cancel lands. The terminal status is `"cancelled"` so a
      // caller can distinguish a cancel from a clean finish (RunStatus contract).
      if (inputs.signal?.aborted === true) {
        ctx.finalStatus = "cancelled";
        break;
      }
    }
    return await finalizeLoopOutput(inputs, ctx, budget, sendSpan, lastTurnDecision);
  } finally {
    // #65 — on_session_end hook (previously dead) fires once per run, even on error.
    await inputs.pluginManager?.runOnSessionEndHooks({
      agentId: inputs.agentId,
      runId: inputs.runId,
    });
    if (
      ctxRef !== undefined &&
      ctxRef.memoryProviderHandle !== undefined &&
      inputs.memoryProvider !== undefined
    ) {
      try {
        await inputs.memoryProvider.dispose(ctxRef.memoryProviderHandle);
      } catch (cause) {
        // Still swallowed, per the same contract: dispose MUST be non-throwing on the hot path.
        // Recorded rather than discarded, for the same reason as the sync failure above — the span
        // is live here and a provider that fails to release its handles every run is otherwise
        // invisible to the operator.
        sendSpan?.addEvent("memory.dispose.failed", {
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    sendSpan?.end();
  }
}

/**
 * Everything `runAgentLoop` does AFTER its last turn: diagnose why the loop ended, stamp the span,
 * total usage and cost, flush the memory provider, and shape the output.
 *
 * Extracted because the biome-ignore on `runAgentLoop` argues that context build, LLM round trip,
 * tool dispatch, stop condition and span lifecycle stay co-located so the streaming contract reads
 * linearly — and that argument, which has real force, covers none of this. None of it runs during a
 * turn, and removing it takes roughly 55 of the function's 123 lines and 12 of its decision points
 * out of the narrative the ignore defends, without moving a single branch of the round trip.
 */
async function emitAssistantTextStep(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  text: string,
  thinking: LlmThinkingPart | undefined,
): Promise<void> {
  ctx.events.push(buildAssistantEvent(inputs, text));
  // theokit#122 — thinking and text belong to ONE assistant message. Anthropic requires the
  // thinking block to come first in the message it belongs to, and `mapAgentTurn` folds one
  // conversation turn into one assistant record — so they must share a turn, in this order.
  const steps: import("../../types/conversation.js").ConversationStep[] = [
    ...(thinking !== undefined ? [thinkingStep(thinking)] : []),
    { type: "assistantMessage" as const, message: { text } },
  ];
  ctx.conversation.push({ type: "agentConversationTurn", turn: { steps } });
  ctx.finalText = text;
  if (inputs.onStep === undefined) return;
  const cb = inputs.onStep;
  await safeCall(
    () => cb({ step: { type: "assistantMessage", message: { text } } }),
    undefined,
    "SendOptions.onStep",
  );
}

/**
 * Build the ordered `toolCall` (+ paired `toolResult`) steps for a tool-using turn. Shared by the
 * live `onStep` emission and the `Run.conversation()` accumulation so the two surfaces never drift
 * (#SE39 — onStep previously emitted `toolCall` but dropped `toolResult`; both now use this).
 */
function buildToolSteps(
  calls: LlmToolCallPart[],
  results: LlmContentPart[],
): import("../../types/conversation.js").ConversationStep[] {
  const steps: import("../../types/conversation.js").ConversationStep[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call === undefined) continue;
    steps.push({
      type: "toolCall",
      message: { callId: call.id, name: call.name, args: call.input },
    });
    const result = results[i];
    if (result?.type === "tool_result") {
      steps.push({
        type: "toolResult",
        message: {
          callId: result.toolUseId ?? call.id,
          name: call.name,
          result:
            typeof result.content === "string" ? result.content : JSON.stringify(result.content),
          isError: result.isError === true,
        },
      });
    }
  }
  return steps;
}

function pushToolConversationSteps(
  ctx: LoopContext,
  calls: LlmToolCallPart[],
  results: LlmContentPart[],
): void {
  const steps = buildToolSteps(calls, results);
  if (steps.length > 0) {
    ctx.conversation.push({ type: "agentConversationTurn", turn: { steps } });
  }
}

function handleToolErrorContinuation(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  toolResults: LlmContentPart[],
): "continue" | "error" {
  const hasError = toolResults.some((part) => part.type === "tool_result" && part.isError === true);
  if (hasError) {
    ctx._consecutiveToolErrors = (ctx._consecutiveToolErrors ?? 0) + 1;
    const cap = (inputs as { maxConsecutiveToolErrors?: number }).maxConsecutiveToolErrors ?? 3;
    if (ctx._consecutiveToolErrors >= cap) return "error";
    return "continue";
  }
  ctx._consecutiveToolErrors = 0;
  return "continue";
}

function shouldNudgeAndContinue(ctx: LoopContext, llmOutput: LlmTurnOutput): boolean {
  if (ctx.nudgeAttempts >= MAX_NUDGE_ATTEMPTS) return false;
  const validation = validateResponse({
    content: llmOutput.text,
    toolCalls: llmOutput.toolCalls,
  });
  if (validation.ok) return false;
  ctx.nudgeAttempts += 1;
  ctx.messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "Please continue your previous answer or provide a final answer.",
      },
    ],
  });
  return true;
}

/**
 * M1-4 — fire the file-based `stop` hook at the clean-finish terminal and, when a
 * hook returns `decision:"feedback"`, push that feedback as a `user` re-prompt and
 * continue the loop (a bounded reflection ladder). Returns `true` to re-prompt,
 * `false` to finish.
 *
 * The hook is ALWAYS fired on a clean finish (so an observer `stop` hook sees
 * every terminal, even once the re-prompt ceiling is reached). `decision:"deny"`
 * is authoritative regardless of hook ordering (`result.blocked`) → finish.
 * Re-prompting is bounded by `MAX_STOP_FEEDBACK_ATTEMPTS` (ADR D3); `allow`/
 * `deny`/no-hook all finish (ADR D2). Reuses the existing `HooksExecutor` (ADR D4).
 *
 * @internal
 */
export async function reflectAfterStop(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
): Promise<boolean> {
  // Always fire `stop` on a clean finish — an observer hook must see the terminal
  // even at the re-prompt ceiling (the ceiling gates re-prompting, not firing).
  const result = await inputs.hooks.run({
    event: "stop",
    agentId: inputs.agentId,
    runId: inputs.runId,
  });
  // A `deny` short-circuits the executor (`blocked`) and is authoritative
  // regardless of hook ordering — a later feedback never overrides an earlier deny.
  if (result.blocked) return false;
  if (ctx.stopFeedbackAttempts >= MAX_STOP_FEEDBACK_ATTEMPTS) return false;
  const feedback = result.decisions.find(
    (d) => d.decision === "feedback" && (d.feedback ?? "").length > 0,
  )?.feedback;
  if (feedback === undefined) return false;
  ctx.stopFeedbackAttempts += 1;
  ctx.messages.push({ role: "user", content: [{ type: "text", text: feedback }] });
  return true;
}

/**
 * M1-4 — the clean-finish decision: nudge (incomplete answer) OR `stop`-hook
 * feedback re-prompt (both bounded) keep the loop going; otherwise finish.
 *
 * @internal
 */
async function finishOrReflect(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  llmOutput: LlmTurnOutput,
): Promise<"continue" | "done"> {
  if (shouldNudgeAndContinue(ctx, llmOutput)) return "continue";
  if (await reflectAfterStop(inputs, ctx)) return "continue";
  ctx.finalStatus = "finished";
  return "done";
}

async function runIteration(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
): Promise<"continue" | "done" | "error"> {
  // #65 — pre/post_llm_call hooks (previously dead) fire around each LLM turn.
  const hookCtx = { agentId: inputs.agentId, runId: inputs.runId };
  await inputs.pluginManager?.runPreLlmCallHooks(hookCtx);
  const llmOutput = await streamLlmTurn(inputs, ctx);
  await inputs.pluginManager?.runPostLlmCallHooks(hookCtx);
  accumulateUsage(ctx.usage, llmOutput);
  trackTurnUsage(inputs, llmOutput);
  return continueOrTerminate(inputs, ctx, llmOutput);
}

/**
 * Report one turn's tokens to the run's BudgetTracker. `inputTokens` is the uncached slice on every
 * client, and BudgetUsageEvent has only "input" and "output", so the input event carries the whole
 * prompt: uncached plus both cache buckets (F-dom-5).
 */
function trackTurnUsage(inputs: AgentLoopInputs, llmOutput: LlmTurnOutput): void {
  const tracker = inputs.budgetTracker;
  if (tracker === undefined) return;
  const modelId = inputs.model.id ?? "auto";
  const inputT =
    (llmOutput.inputTokens ?? 0) +
    (llmOutput.cacheReadTokens ?? 0) +
    (llmOutput.cacheWriteTokens ?? 0);
  const outputT = llmOutput.outputTokens ?? 0;
  try {
    if (inputT > 0) {
      tracker.track({
        tokens: inputT,
        model: modelId,
        type: "input",
      });
    }
    if (outputT > 0) {
      tracker.track({
        tokens: outputT,
        model: modelId,
        type: "output",
      });
    }
  } catch {
    // Tracker.track() is contracted as non-throwing — swallow.
  }
}

/** #65 — apply the transform_llm_output hook fold (no-op when no plugin manager). */
async function transformLlmOutputText(
  inputs: AgentLoopInputs,
  text: string,
  ctx: { agentId: string; runId: string },
): Promise<string> {
  return inputs.pluginManager !== undefined
    ? inputs.pluginManager.runTransformLlmOutputHooks(text, ctx)
    : text;
}

/**
 * #57/#65 — built-in tool-result guard then the transform_tool_result hook fold.
 *
 * M82 — `toolCalls` is threaded into the hook context. The data was already in the caller's scope
 * (`llmOutput.toolCalls`) and was simply dropped, which left this seam — the ONLY tool-stage channel
 * whose return value the SDK applies — unable to say which tool produced which result. A scoped
 * policy therefore had to sit on `post_tool_call`, whose return is discarded, and silently degraded
 * to observation. Plural because the seam is batch-shaped; correlate by `toolUseId === id`.
 */
async function guardAndTransformToolResults(
  inputs: AgentLoopInputs,
  raw: LlmContentPart[],
  ctx: { agentId: string; runId: string },
  toolCalls: readonly LlmToolCallPart[],
): Promise<LlmContentPart[]> {
  const guarded =
    inputs.toolResultGuard !== undefined ? applyToolResultGuard(raw, inputs.toolResultGuard) : raw;
  return inputs.pluginManager !== undefined
    ? inputs.pluginManager.runTransformToolResultHooks(guarded, {
        ...ctx,
        toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.input })),
      })
    : guarded;
}

export async function continueOrTerminate(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  llmOutput: LlmTurnOutput,
): Promise<"continue" | "done" | "error"> {
  if (llmOutput.errored) return "error";
  const tCtx = { agentId: inputs.agentId, runId: inputs.runId };
  // #65 — apply `transform_llm_output` ONCE, up front, so the transformed text
  // reaches the user-visible step + finalText + the message history, on final
  // text turns as well as tool-call turns (previously it ran only in the
  // tool_use branch and only into message history, never touching what the
  // caller actually receives).
  const text =
    llmOutput.text.length > 0
      ? await transformLlmOutputText(inputs, llmOutput.text, tCtx)
      : llmOutput.text;
  // theokit#122 — the round's block, consumed exactly once, on whichever path closes this round.
  const thinking = llmOutput.thinking;
  if (text.length > 0) {
    await emitAssistantTextStep(inputs, ctx, text, thinking);
  }
  if (llmOutput.stopReason !== "tool_use" || llmOutput.toolCalls.length === 0) {
    return finishOrReflect(inputs, ctx, llmOutput);
  }
  recordThinkingOnSilentToolRound(ctx, text, thinking);
  // theokit#122 — and the REPLAY must carry it too: Anthropic verifies the signed block on the next
  // request, so an assistant turn that reaches the provider without it is rejected outright.
  ctx.messages.push(buildAssistantTurn(text, llmOutput.toolCalls, thinking));
  const rawResults = await dispatchTools(
    // SE12 — forward a read-only text projection of the transcript-so-far to tool
    // handlers via `ctx.messages` (consumed by defineSubAgent's messageFilter).
    { ...inputs, messages: projectToolContextMessages(ctx.messages) },
    ctx.tools,
    llmOutput.toolCalls,
    ctx.events,
    ctx.sendSpan, // M3 #64 — nest tool.call spans under agent.send
  );
  const toolResults = await guardAndTransformToolResults(
    inputs,
    rawResults,
    tCtx,
    llmOutput.toolCalls,
  );
  ctx.messages.push({ role: "user", content: toolResults });
  if (inputs.onStep !== undefined) {
    const cb = inputs.onStep;
    // SE39 — emit toolCall AND the paired toolResult (was toolCall-only: an asymmetry vs the
    // ConversationStep union + Run.conversation()). Shared builder keeps the two surfaces in lock-step.
    for (const step of buildToolSteps(llmOutput.toolCalls, toolResults)) {
      await safeCall(() => cb({ step }), undefined, "SendOptions.onStep");
    }
  }
  pushToolConversationSteps(ctx, llmOutput.toolCalls, toolResults);
  if ((await inspectDoomLoop(inputs, ctx, llmOutput.toolCalls)) === "stop") return "done";
  return handleToolErrorContinuation(inputs, ctx, toolResults);
}

/**
 * Doom-loop guard, inspected after each turn's tools dispatch (kept in lockstep with the pure
 * `firstDoomLoopVerdict` — see agent-loop/doom-loop-wiring.test.ts). A `hard` verdict emits the stop
 * message as the final assistant text, flags `ctx.stoppedByDoomLoop`, and stops the run (a controlled
 * `done`). A `soft` verdict injects a one-time guidance nudge (once per streak, by the `==softThreshold`
 * semantics) and continues. No tracker (`doomLoop: false`) ⇒ never fires. @internal
 */
async function inspectDoomLoop(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  toolCalls: LlmToolCallPart[],
): Promise<"stop" | "continue"> {
  if (ctx.doomLoop === undefined) return "continue";
  const verdict = firstDoomLoopVerdict(ctx.doomLoop, toolCalls);
  if (verdict.kind === "hard") {
    ctx.stoppedByDoomLoop = true;
    await emitAssistantTextStep(
      inputs,
      ctx,
      verdict.message ?? "Stopped: repeated identical tool calls made no progress.",
      // The doom-loop stop message is the SDK's own text, not a model turn — it has no thinking.
      undefined,
    );
    return "stop";
  }
  if (verdict.kind === "soft") {
    ctx.messages.push({ role: "user", content: [{ type: "text", text: verdict.message ?? "" }] });
  }
  return "continue";
}

/** Re-export safeListTools for backward compatibility. @internal */
export { safeListTools } from "./loop-context-init.js";
