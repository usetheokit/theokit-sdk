/**
 * The tail of `runAgentLoop`: everything that happens after its last turn.
 *
 * Its own module rather than four more functions in `loop.ts` for two reasons that agree. The file
 * was 12 logical lines over the 400-line budget with them inline, and more importantly the split is
 * real: nothing here runs during a turn, so none of it is covered by the argument the loop's
 * `biome-ignore` makes about keeping the streaming contract linear.
 *
 * @internal
 */

import type { IterationBudget } from "../budget/tracker/budget.js";
import type { LoopContext } from "./loop-context-init.js";
import type { AgentLoopInputs, AgentLoopOutput } from "./types.js";
import { computeUsageCost } from "./usage-and-cost.js";

/** The span type the telemetry handle hands back, or nothing when telemetry is off. */
export type SendSpan =
  | ReturnType<NonNullable<AgentLoopInputs["telemetry"]>["startSpan"]>
  | undefined;

/**
 * Decide what the END of the loop means, and record it on the context.
 *
 * Two different truths about one exit. `stoppedAtIterationLimit` is the structured signal that the
 * budget ran out mid-work; the error is the same fact written where errors are read, because
 * `status: "error"` with an empty result is byte-for-byte the shape a provider rejection produces
 * and a caller cannot tell the two apart (#338 item 4, `rules/error-handling.md` § 2-3).
 */
function diagnoseTermination(
  ctx: LoopContext,
  budget: IterationBudget,
  lastTurnDecision: "continue" | "done" | "error" | undefined,
): void {
  const exhausted = budget.shouldContinue() === false;
  // M1-2 (T2.2): the loop exited because the iteration budget is exhausted (not via a `done`/`error`
  // break) while the last turn still wanted tools — a silent truncation the caller (or a
  // continuation driver) must detect.
  if (lastTurnDecision === "continue" && exhausted) ctx.stoppedAtIterationLimit = true;
  if (!exhausted || ctx.finalStatus !== "finished" || ctx.finalText !== "") return;

  ctx.finalStatus = "error";
  // Set-once, like every other writer of `ctx.error`: a real failure that already registered itself
  // keeps its own cause, and exhaustion never overwrites it.
  if (ctx.error !== undefined) return;
  ctx.error = {
    message:
      `Run stopped after ${budget.total} iteration(s) without producing a reply — the model ` +
      "was still calling tools when the budget ran out. Raise `SendOptions.maxIterations` " +
      "(default 8), or inspect `RunResult.stoppedAtIterationLimit` to continue the run.",
    code: "iteration_limit_reached",
  };
}

/**
 * Stamp the run's outcome onto the `agent.send` span.
 *
 * `stoppedByDoomLoop` is an attribute rather than a status because a doom-loop stop reports
 * `finished` — a controlled stop — so without it the span is indistinguishable from a clean finish
 * and ops cannot see the guard fire.
 */
function stampSendSpan(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  sendSpan: SendSpan,
  usage: ReturnType<LoopContext["usage"]["toTokenUsage"]> | undefined,
  cost: ReturnType<typeof computeUsageCost> | undefined,
): void {
  sendSpan?.setAttribute("status", ctx.finalStatus);
  if (ctx.stoppedByDoomLoop === true) sendSpan?.setAttribute("stoppedByDoomLoop", true);
  if (inputs.telemetry?.includeContent === true && ctx.finalText.length > 0) {
    sendSpan?.addEvent("response", { content: ctx.finalText });
  }
  if (usage === undefined) return;
  sendSpan?.setAttributes({
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    ...(cost?.amountUsd !== undefined ? { totalCostUsd: cost.amountUsd } : {}),
  });
}

/** Flush the memory provider on a clean finish. `sync()` MUST be non-throwing on the hot path. */
async function syncMemoryProvider(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  sendSpan: SendSpan,
): Promise<void> {
  if (ctx.finalStatus !== "finished") return;
  if (ctx.memoryProviderHandle === undefined || inputs.memoryProvider?.sync === undefined) return;
  try {
    await inputs.memoryProvider.sync(ctx.memoryProviderHandle);
  } catch (cause) {
    // Still swallowed — a memory sync failure must not fail a finished run, and `sync()` is
    // contracted non-throwing. What changed is that the fact stops being invisible: a memory index
    // that has quietly stopped syncing used to produce a run that was green in every surface an
    // operator has. The span is live and being written to on the lines around this one, so recording
    // it costs a line.
    sendSpan?.addEvent("memory.sync.failed", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Everything `runAgentLoop` does AFTER its last turn: diagnose why the loop ended, stamp the span,
 * total usage and cost, flush the memory provider, and shape the output.
 *
 * Extracted because the biome-ignore on `runAgentLoop` argues that context build, LLM round trip,
 * tool dispatch, stop condition and span lifecycle stay co-located so the streaming contract reads
 * linearly — and that argument, which has real force, covers none of this. None of it runs during a
 * turn, so removing it takes roughly 55 of the function's 123 lines and 12 of its decision points
 * out of the narrative the ignore defends, without moving a single branch of the round trip.
 */
export async function finalizeLoopOutput(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  budget: IterationBudget,
  sendSpan: SendSpan,
  lastTurnDecision: "continue" | "done" | "error" | undefined,
): Promise<AgentLoopOutput> {
  diagnoseTermination(ctx, budget, lastTurnDecision);
  const usage = ctx.usage.hasAny() ? ctx.usage.toTokenUsage() : undefined;
  const cost = usage !== undefined ? computeUsageCost(inputs, usage) : undefined;
  stampSendSpan(inputs, ctx, sendSpan, usage, cost);
  await syncMemoryProvider(inputs, ctx, sendSpan);
  return {
    events: ctx.events,
    finalStatus: ctx.finalStatus,
    result: ctx.finalText,
    conversation: ctx.conversation,
    ...(usage !== undefined ? { usage } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(ctx.error !== undefined ? { error: ctx.error } : {}),
    ...(ctx.stoppedAtIterationLimit === true ? { stoppedAtIterationLimit: true } : {}),
    ...(ctx.stoppedByDoomLoop === true ? { stoppedByDoomLoop: true } : {}),
    ...(ctx.deferredToolCalls !== undefined ? { deferredToolCalls: ctx.deferredToolCalls } : {}),
  };
}
