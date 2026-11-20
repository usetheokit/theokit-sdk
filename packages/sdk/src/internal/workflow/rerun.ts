/**
 * Workflow history and re-run from a step (#1097).
 *
 * @internal
 */

import type {
  Step,
  WorkflowCheckpoint,
  WorkflowOptions,
  WorkflowRerunOptions,
  WorkflowRun,
} from "../../types/workflow.js";
import {
  WorkflowResumeStepNotFoundError,
  WorkflowResumeWorkflowMismatchError,
  WorkflowSnapshotNotFoundError,
} from "../../workflow-errors.js";
import { executeWorkflow } from "./executor.js";
import { getSnapshotStoreFor } from "./snapshot-store.js";

/** Retained checkpoints of `runId` for this workflow, oldest first, without internal fields. */
export async function workflowHistory(
  options: WorkflowOptions,
  runId: string,
): Promise<ReadonlyArray<WorkflowCheckpoint>> {
  const entries = await getSnapshotStoreFor(options).loadHistory(runId);
  return entries
    .filter((e) => e.workflowName === options.name)
    .map((e) => ({
      runId: e.runId,
      stepId: e.stepId,
      output: e.output,
      ...(e.state !== undefined ? { state: e.state } : {}),
      at: e.at,
    }));
}

/** Fork `opts.runId` at `opts.stepId`: a new run id executes that step and the rest from the stored point. */
export async function rerunWorkflowFrom<TO>(
  options: WorkflowOptions,
  steps: ReadonlyArray<Step>,
  opts: WorkflowRerunOptions,
): Promise<WorkflowRun<TO>> {
  const idx = steps.findIndex((s) => s.id === opts.stepId);
  if (idx < 0) throw new WorkflowResumeStepNotFoundError(opts.stepId, options.name);
  const entries = await getSnapshotStoreFor(options).loadHistory(opts.runId);
  const owned = entries.filter((e) => e.workflowName === options.name);
  if (owned.length === 0) {
    if (entries[0] !== undefined) {
      throw new WorkflowResumeWorkflowMismatchError(
        opts.runId,
        entries[0].workflowName,
        options.name,
      );
    }
    throw new WorkflowSnapshotNotFoundError(opts.runId);
  }
  const anchorId = idx === 0 ? opts.stepId : (steps[idx - 1] as Step).id;
  const anchor = owned.find((e) => e.stepId === anchorId);
  if (anchor === undefined) throw new WorkflowSnapshotNotFoundError(opts.runId);
  const stored = idx === 0 ? anchor.input : anchor.output;
  const input = "input" in opts ? opts.input : stored;
  const run = await executeWorkflow<unknown, TO>(options, steps.slice(idx), input, {
    signal: opts.signal,
    // Restoring the state of the earlier point; the first step starts from `initialState` as a fresh run does.
    ...(idx > 0 && anchor.state !== undefined ? { restoredState: anchor.state } : {}),
    skipInputValidation: idx > 0,
  } as Parameters<typeof executeWorkflow>[3]);
  return { ...run, rerunOf: { runId: opts.runId, stepId: opts.stepId } };
}
