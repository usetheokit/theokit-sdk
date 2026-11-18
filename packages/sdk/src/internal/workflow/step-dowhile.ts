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
  const { dispatch } = exec;
  const startedAt = Date.now();
  const maxIter = step.maxIterations ?? 100;
  let acc = input;
  let i = 0;
  while (true) {
    if (i >= maxIter) {
      return {
        stepId: step.id,
        kind: "dowhile",
        status: "failed",
        attempts: i,
        durationMs: Date.now() - startedAt,
        error: errToShape(new WorkflowMaxIterationsExceededError(step.id, maxIter)),
      };
    }
    const r = await dispatch(step.step, acc, exec);
    if (r.status === "failed") {
      return {
        stepId: step.id,
        kind: "dowhile",
        status: "failed",
        attempts: i + 1,
        durationMs: Date.now() - startedAt,
        error: r.error,
      };
    }
    acc = r.output;
    i += 1;
    let shouldContinue = false;
    try {
      shouldContinue = await Promise.resolve(step.condFn(acc, i));
    } catch (err) {
      return {
        stepId: step.id,
        kind: "dowhile",
        status: "failed",
        attempts: i,
        durationMs: Date.now() - startedAt,
        error: errToShape(err),
      };
    }
    if (!shouldContinue) break;
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
