/**
 * Goal-driven Ralph loop (T3.2, ADRs D115-D121).
 *
 * `runUntilImpl` is an `AsyncGenerator<GoalEvent, GoalResult, void>`:
 * yields events as the loop progresses, returns the final result when
 * the goal completes, fails, or is paused. The auxiliary judge model is
 * injected via `deps.judge` so the generator stays free of the `Agent`
 * façade import.
 *
 * EC-C fix: pre-aborted signals emit only `[paused]`, not `[active, paused]`.
 * EC-D: `maxTurns: 0` is supported (vacuous yield active → failed).
 *
 * @internal
 */

import type { SDKAgent } from "../../../types/agent.js";
import type {
  GoalEvent,
  GoalOptions,
  GoalResult,
  JudgeResult,
} from "../../../types/goal-events.js";
import type { JudgeContext, JudgeOptions } from "../../judge/judge-call.js";
import { GOAL_CONTINUATION_MARKER } from "./goal-marker.js";

/** DI contract: the judge is the only external touchpoint. */
export interface RunUntilDeps {
  judge: (ctx: JudgeContext, opts?: JudgeOptions) => Promise<JudgeResult>;
}

/** The reason both in-loop abort checks report; the pre-loop one distinguishes itself. */
const ABORTED_MID_RUN = "aborted via AbortSignal";

/**
 * The pause event, built in one place. Three sites emitted the same four-line literal with only the
 * reason varying — the same duplicated-knowledge shape as `finish` below, at the event boundary
 * instead of the result boundary.
 */
const pausedBy = (reason: string): GoalEvent => ({
  type: "status_change",
  status: "paused",
  reason,
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the goal-loop interleaves turn-start, send, judge, continuation, abort-check and failure-bail — extracting the CONTROL FLOW into helpers harms that linear narrative, and this defends only that. What it never covered were the nine hand-built result literals and the three pause events, which moved to `finish` and `pausedBy` above: neither removes a branch. Measured 2026-09-01: 43 -> 31 cognitive, 150 -> 117 lines.
export async function* runUntilImpl(
  agent: SDKAgent,
  goal: string,
  options: GoalOptions | undefined,
  deps: RunUntilDeps,
): AsyncGenerator<GoalEvent, GoalResult, void> {
  const maxTurns = options?.maxTurns ?? 20;
  const maxFails = options?.maxConsecutiveJudgeFailures ?? 3;
  const tokenBudget = options?.tokenBudget; // M55 — undefined ⇒ unlimited
  const signal = options?.signal;
  // Use a function (not direct property access) so TS does not narrow
  // `signal.aborted` to `false | undefined` after the initial check.
  // AbortSignal.aborted is a getter that can flip true between calls.
  // biome-ignore lint/complexity/useOptionalChain: optional-chain would re-narrow signal?.aborted to `false | undefined` after the first check, defeating the purpose of this helper.
  const isAborted = (): boolean => signal !== undefined && signal.aborted;
  let turn = 0;
  let consecutiveFailures = 0;
  let tokensUsed = 0; // M55 — the observed sum (0 when usage is absent — fail-open)
  let lastResponse = "";
  /**
   * The one place a `GoalResult` is built. Every exit went through the same four-field literal with
   * only the status varying, nine times, each restating the convention that an empty final response
   * collapses to `undefined` — duplicated KNOWLEDGE, so adding a field to `GoalResult` was a
   * nine-site edit where missing one produces a result wrong on a single branch.
   *
   * It is a closure over `turn`, `tokensUsed` and `lastResponse` rather than a module function
   * precisely so the call sites stay one word long: the biome-ignore below argues that the loop's
   * narrative must read linearly, and this removes no branch and moves no decision.
   */
  const finish = (status: GoalResult["status"]): GoalResult => ({
    status,
    turnsUsed: turn,
    tokensUsed,
    finalResponse: lastResponse || undefined,
  });

  // EC-C: signal already aborted BEFORE first event → emit only [paused].
  if (isAborted()) {
    yield pausedBy("aborted via AbortSignal before first turn");
    // `turn` is 0 and `lastResponse` is "" at this point, so this is the literal it replaces.
    return finish("paused");
  }

  yield { type: "status_change", status: "active", reason: "Goal started" };

  while (turn < maxTurns) {
    if (isAborted()) {
      yield pausedBy(ABORTED_MID_RUN);
      return finish("paused");
    }

    turn += 1;
    yield { type: "turn_start", turn, goal };

    const continuationPrompt = turn === 1 ? goal : composeContinuation(goal, lastResponse);

    const run = await agent.send(continuationPrompt);
    // M55 review HIGH — thread the abort INTO the in-flight run: without this, Esc mid-turn is
    // cosmetic (the turn keeps mutating the workspace until it finishes on its own). `run.cancel()`
    // aborts the stream + in-flight tool calls (types/run.ts contract).
    // Called directly, not through a hand-written shape. `SDKAgent.send()` returns `Promise<Run>`
    // and `Run.cancel(): Promise<void>` is declared in `types/run.ts` — the cast re-declared, less
    // precisely, what the compiler already knew, and `cancel?.()` through it meant a rename would
    // keep compiling while Esc mid-turn silently went back to being cosmetic. Which is the exact
    // defect the comment above says this was added to fix.
    const cancelOnAbort = (): void => {
      void run.cancel();
    };
    if (signal !== undefined) {
      if (signal.aborted) cancelOnAbort();
      else signal.addEventListener("abort", cancelOnAbort, { once: true });
    }
    // B-498 — in a `finally`: under `throwOnError` a failed turn's `wait()` rejects, and the
    // listener must not outlive the turn on the caller's signal.
    let result: Awaited<ReturnType<typeof run.wait>>;
    try {
      result = await run.wait();
    } finally {
      if (signal !== undefined) signal.removeEventListener("abort", cancelOnAbort);
    }
    lastResponse = result.result ?? "";
    // M55 — token accounting fails open: it only sums when the run reports usage.
    const turnTokens = result.usage?.totalTokens;
    if (typeof turnTokens === "number") tokensUsed += turnTokens;
    // Re-check aborted right after the turn lands: a cancelled turn must NOT spend a judge call.
    if (isAborted()) {
      yield pausedBy(ABORTED_MID_RUN);
      return finish("paused");
    }
    yield { type: "agent_response", turn, content: lastResponse };

    const judgeOpts: JudgeOptions = {};
    if (options?.judgeModel !== undefined) judgeOpts.judgeModel = options.judgeModel;
    if (options?.judgeApiKey !== undefined) judgeOpts.apiKey = options.judgeApiKey;
    // M80 — forwards the driven agent's model so the judge can derive when `judgeModel` is omitted.
    if (options?.agentModel !== undefined) judgeOpts.agentModel = options.agentModel;
    const judgeCtx: JudgeContext = { goal, lastResponse };
    if (options?.subgoals !== undefined) judgeCtx.subgoals = options.subgoals;
    const judgment = await deps.judge(judgeCtx, judgeOpts);
    yield {
      type: "judge_verdict",
      turn,
      verdict: judgment.verdict,
      reason: judgment.reason,
      parseFailed: judgment.parseFailed,
    };

    if (judgment.parseFailed) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFails) {
        yield {
          type: "status_change",
          status: "failed",
          reason: `judge model too unreliable (${consecutiveFailures} parse failures in a row)`,
        };
        return finish("failed");
      }
    } else {
      consecutiveFailures = 0;
    }

    if (judgment.verdict === "done") {
      yield { type: "status_change", status: "completed", reason: judgment.reason };
      return finish("completed");
    }
    // M80 — the missing arm. Without it, a judge recognizing impossibility could only say
    // "continue", and the loop repeated the same turn until it blew the budget — reporting `failed` on
    // a limit rather than `blocked` on impossibility. Two distinct causes with the same
    // visible outcome, and the consumer had to reconcile after the loop to tell them apart.
    if (judgment.verdict === "blocked") {
      yield { type: "status_change", status: "blocked", reason: judgment.reason };
      return finish("blocked");
    }
    if (judgment.verdict === "skipped") {
      yield {
        type: "status_change",
        status: "completed",
        reason: `skipped: ${judgment.reason}`,
      };
      return finish("completed");
    }

    // M55 — token-budget check AFTER the turn (Codex: gentle wind-down, stops the loop).
    if (tokenBudget !== undefined && tokensUsed >= tokenBudget) {
      yield {
        type: "status_change",
        status: "budget_limited",
        reason: `token budget (${tokenBudget}) reached: ${tokensUsed} used`,
      };
      return finish("budget_limited");
    }

    yield { type: "continuation", turn, prompt: continuationPrompt };
  }

  yield {
    type: "status_change",
    status: "failed",
    reason: `max turns (${maxTurns}) exhausted`,
  };
  return finish("failed");
}

/**
 * Build the continuation user message for turns 2+. Keeps last response
 * preview short so we don't bloat the prompt cache.
 *
 * @internal
 */

export function composeContinuation(goal: string, lastResponse: string): string {
  // M55 — Codex-faithful continuation (ext/goal templates/goals/continuation.md): keep the FULL
  // objective intact, work from current-state evidence, and audit completion requirement-by-requirement
  // before declaring done. Improves the quality of what the judge then evaluates.
  return [
    GOAL_CONTINUATION_MARKER,
    "Continue working toward the active goal.",
    "",
    `<objective>\n${goal}\n</objective>`,
    "",
    "Continuation behavior:",
    "- This goal persists across turns. Keep the full objective intact; if it cannot be finished now,",
    "  make concrete progress toward the real requested end state and do not redefine success around a",
    "  smaller or easier task.",
    "",
    "Work from evidence:",
    "- Use the current worktree and external state as authoritative. Inspect the current state before",
    "  relying on it. Improve, replace, or remove existing work as needed to satisfy the actual objective.",
    "",
    "Completion audit:",
    "- Before deciding the goal is achieved, treat completion as unproven and verify it against the actual",
    "  current state, requirement by requirement. Treat uncertain or indirect evidence as not achieved.",
    "",
    `Your last response was:\n${lastResponse.slice(-1000)}`,
  ].join("\n");
}
