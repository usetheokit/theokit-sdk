/**
 * Saga compensation for top-level fn steps (#1098).
 *
 * @internal
 */

import type {
  CompensationResult,
  FnStep,
  Step,
  StepResult,
  WorkflowEvent,
  WorkflowRun,
} from "../../types/workflow.js";
import { errToShape } from "./error-shape.js";

/** A completed top-level fn step that declared `compensate`, with what it needs to undo. */
export interface Compensable {
  step: FnStep;
  input: unknown;
  output: unknown;
}

function errorFromShape(shape: { name: string; message: string } | undefined): Error {
  const err = new Error(shape?.message ?? "step failed");
  if (shape !== undefined) err.name = shape.name;
  return err;
}

/** Call each `compensate` in reverse completion order; a throwing one is recorded, not fatal. */
async function runCompensation(
  done: ReadonlyArray<Compensable>,
  error: Error,
  onStepEvent?: (event: WorkflowEvent) => void,
): Promise<CompensationResult[]> {
  const results: CompensationResult[] = [];
  for (const { step, input, output } of [...done].reverse()) {
    try {
      await step.compensate?.(input, output, error);
      results.push({ stepId: step.id, status: "compensated" });
      onStepEvent?.({ type: "step_compensated", stepId: step.id });
    } catch (err) {
      const shape = errToShape(err);
      results.push({ stepId: step.id, status: "failed", error: shape });
      onStepEvent?.({ type: "step_compensation_failed", stepId: step.id, error: shape });
    }
  }
  return results;
}

/** Compensate after a failed (not cancelled) top-level step; returns the run with `compensation`. */
async function failWithCompensation<TO>(
  run: WorkflowRun<TO>,
  done: ReadonlyArray<Compensable>,
  signal: AbortSignal,
  onStepEvent?: (event: WorkflowEvent) => void,
): Promise<WorkflowRun<TO>> {
  if (done.length === 0 || signal.aborted) return run;
  const compensation = await runCompensation(done, errorFromShape(run.error), onStepEvent);
  return { ...run, compensation };
}

/** Settle one step: compensate on a failed step, else record a compensable completion. */
export async function settleStep<TO>(
  handled: { terminal: WorkflowRun<TO> } | { acc: unknown },
  args: {
    outcome: { kind: "ok"; result: StepResult } | { kind: "terminal"; run: WorkflowRun<TO> };
    step: Step;
    input: unknown;
    done: Compensable[];
    signal: AbortSignal;
    onStepEvent?: (event: WorkflowEvent) => void;
  },
): Promise<{ terminal: WorkflowRun<TO> } | { acc: unknown }> {
  const { outcome, step, done } = args;
  if ("terminal" in handled) {
    if (outcome.kind !== "ok" || outcome.result.status !== "failed") return handled;
    const run = await failWithCompensation(handled.terminal, done, args.signal, args.onStepEvent);
    return { terminal: run };
  }
  if (step.kind === "fn" && step.compensate !== undefined) {
    done.push({ step, input: args.input, output: handled.acc });
  }
  return handled;
}
