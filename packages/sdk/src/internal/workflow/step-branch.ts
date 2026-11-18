/**
 * Execute a `BranchStep` — first-match-wins predicates + optional fallback.
 *
 * EC-2 absorbed: predicates that THROW are treated as "no match" + stderr
 * warn — user-code bugs in predicates don't take down the whole workflow.
 *
 * @internal
 */

import type { BranchStep, Step, StepResult } from "../../types/workflow.js";
import { diag } from "../diagnostics.js";
import { redactSecrets } from "../security/redact.js";
import { errToShape } from "./error-shape.js";
import type { StepExecution } from "./step-execution.js";

export async function runBranchStep(
  step: BranchStep,
  input: unknown,
  exec: StepExecution,
): Promise<StepResult> {
  const startedAt = Date.now();

  for (let i = 0; i < step.predicates.length; i += 1) {
    const pair = step.predicates[i]!;
    const [predicate, branch] = pair;
    // EC-2: predicate throw → warn + treat as no-match.
    let matched = false;
    try {
      matched = await Promise.resolve(predicate(input));
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      // theokit#147 — the interceptable channel, so a workflow running under a TUI cannot
      // corrupt its frame with a predicate warning.
      diag(
        redactSecrets(
          `[workflow] branch "${step.id}" predicate ${i} threw, treating as no-match: ${errText}\n`,
        ),
      );
    }
    if (matched) {
      const r = await runInnerSequence(branch, input, exec);
      return {
        ...r,
        stepId: step.id,
        kind: "branch",
        durationMs: Date.now() - startedAt,
      };
    }
  }

  if (step.fallback !== undefined) {
    const r = await runInnerSequence(step.fallback, input, exec);
    return {
      ...r,
      stepId: step.id,
      kind: "branch",
      durationMs: Date.now() - startedAt,
    };
  }

  // No match, no fallback → pass input through unchanged.
  return {
    stepId: step.id,
    kind: "branch",
    status: "skipped",
    attempts: 0,
    durationMs: Date.now() - startedAt,
    output: input,
  };
}

async function runInnerSequence(
  branch: ReadonlyArray<Step>,
  input: unknown,
  exec: StepExecution,
): Promise<StepResult> {
  const { dispatch } = exec;
  let acc: unknown = input;
  let lastAttempts = 1;
  for (const inner of branch) {
    const r = await dispatch(inner, acc, exec);
    lastAttempts = r.attempts;
    if (r.status === "failed") {
      return {
        stepId: inner.id,
        kind: "branch",
        status: "failed",
        attempts: r.attempts,
        durationMs: 0,
        error: r.error ?? errToShape(new Error("branch inner step failed")),
      };
    }
    acc = r.output;
  }
  return {
    stepId: "__branch-completed__",
    kind: "branch",
    status: "completed",
    attempts: lastAttempts,
    durationMs: 0,
    output: acc,
  };
}
