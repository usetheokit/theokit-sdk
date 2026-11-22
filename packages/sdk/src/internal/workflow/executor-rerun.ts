/**
 * `Workflow.rerunFrom()` — fork a new run from a recorded step.
 *
 * @internal
 */

import type {
  Step,
  WorkflowOptions,
  WorkflowRerunOptions,
  WorkflowRun,
} from "../../types/workflow.js";
import {
  WorkflowResumeStepNotFoundError,
  WorkflowResumeWorkflowMismatchError,
  WorkflowSnapshotNotFoundError,
} from "../../workflow-errors.js";
import { executeWorkflow, type InternalRunOpts } from "./executor.js";
import { getSnapshotStoreFor, type WorkflowHistoryEntry } from "./snapshot-store.js";

/* ─── Rerun from a step (fork) ─── */

/** The input and state a fork of `stepId` starts with, from the run's stored history. */
function replayPoint(
  history: ReadonlyArray<WorkflowHistoryEntry>,
  steps: ReadonlyArray<Step>,
  stepIdx: number,
): { input: unknown; state?: unknown } | undefined {
  if (stepIdx === 0) {
    const first = history[0];
    return first === undefined ? undefined : { input: first.runInput };
  }
  const previousId = steps[stepIdx - 1]?.id;
  const entry = [...history].reverse().find((h) => h.stepId === previousId);
  if (entry === undefined) return undefined;
  return { input: entry.output, ...(entry.state !== undefined ? { state: entry.state } : {}) };
}

/**
 * Fork a new run from a top-level step of a recorded run (LangGraph-style): the original run's
 * history is read, never written. Needs `persistence.keepHistory`.
 */
export async function rerunWorkflow<TO>(
  options: WorkflowOptions,
  steps: ReadonlyArray<Step>,
  opts: WorkflowRerunOptions,
): Promise<WorkflowRun<TO>> {
  const history = await getSnapshotStoreFor(options).history(opts.runId);
  const first = history[0];
  if (first === undefined) throw new WorkflowSnapshotNotFoundError(opts.runId);
  if (first.workflowName !== options.name) {
    throw new WorkflowResumeWorkflowMismatchError(opts.runId, first.workflowName, options.name);
  }
  const stepIdx = steps.findIndex((s) => s.id === opts.stepId);
  if (stepIdx < 0) throw new WorkflowResumeStepNotFoundError(opts.stepId, options.name);
  const point = replayPoint(history, steps, stepIdx);
  if (point === undefined) throw new WorkflowSnapshotNotFoundError(opts.runId);
  const input = "input" in opts ? opts.input : point.input;
  const run = await executeWorkflow<unknown, TO>(options, steps.slice(stepIdx), input, {
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(point.state !== undefined ? { restoredState: point.state } : {}),
    skipInputValidation: stepIdx > 0,
  } as InternalRunOpts);
  return { ...run, rerunOf: { runId: opts.runId, stepId: opts.stepId } };
}
