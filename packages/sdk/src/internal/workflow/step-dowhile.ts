/**
 * Execute a `DowhileStep` — loop the inner step until `condFn` returns
 * false or `maxIterations` is reached (default 100).
 *
 * @internal
 */

import type { DowhileStep, StepResult } from "../../types/workflow.js";
import { WorkflowMaxIterationsExceededError } from "../../workflow-errors.js";
import { errToShape } from "./error-shape.js";
import type { StepExecution } from "./step-execution.js";

export async function runDowhileStep(
  step: DowhileStep,
  input: unknown,
  exec: StepExecution,
): Promise<StepResult> {
  const startedAt = Date.now();
  const maxIter = step.maxIterations ?? 100;
  let acc = input;
  let i = 0;
  while (true) {
    if (i >= maxIter) {
      const err = errToShape(new WorkflowMaxIterationsExceededError(step.id, maxIter));
      return stopped(step.id, "failed", i, startedAt, err);
    }
    const it = await iterate(step, acc, i + 1, exec, startedAt);
    if ("stop" in it) return it.stop;
    acc = it.acc;
    i += 1;
    if (!it.more) break;
  }
  return {
    stepId: step.id,
    kind: "dowhile",
    status: "completed",
    attempts: i,
    durationMs: Date.now() - startedAt,
    output: acc,
  };
}

/** One iteration: the inner step, then `condFn`. Returns a terminal result or the next accumulator. */
async function iterate(
  step: DowhileStep,
  acc: unknown,
  n: number,
  exec: StepExecution,
  startedAt: number,
): Promise<{ stop: StepResult } | { acc: unknown; more: boolean }> {
  const r = await exec.dispatch(step.step, acc, exec);
  if (r.status === "cancelled" || r.status === "failed") {
    return { stop: stopped(step.id, r.status, n, startedAt, r.error) };
  }
  const cont = await evalCond(step, r.output, n);
  if (cont instanceof Error) {
    return { stop: stopped(step.id, "failed", n, startedAt, errToShape(cont)) };
  }
  return { acc: r.output, more: cont };
}

/** A dowhile result that ended early: the inner step was cancelled or failed, or the loop broke. */
function stopped(
  id: string,
  status: "cancelled" | "failed",
  attempts: number,
  startedAt: number,
  error: StepResult["error"],
): StepResult {
  return {
    stepId: id,
    kind: "dowhile",
    status,
    attempts,
    durationMs: Date.now() - startedAt,
    error,
  };
}

/** Evaluates `condFn`; a throw is returned as an Error so the caller can fail the step. */
async function evalCond(step: DowhileStep, acc: unknown, i: number): Promise<boolean | Error> {
  try {
    return await Promise.resolve(step.condFn(acc, i));
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
