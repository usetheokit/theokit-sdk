/**
 * `history()` and `rerunFrom()` (`keepHistory: true`).
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
import { executeWorkflow, type InternalRunOpts } from "./executor.js";
import { mintRunId } from "./run-id.js";
import { getSnapshotStoreFor, type WorkflowHistoryRecord } from "./snapshot-store.js";

function toCheckpoint(record: WorkflowHistoryRecord): WorkflowCheckpoint {
  const { snapshot } = record;
  return {
    runId: snapshot.runId,
    stepId: snapshot.currentStepId,
    output: snapshot.accumulatedInput,
    ...(snapshot.state !== undefined ? { state: snapshot.state } : {}),
    at: snapshot.suspendedAt,
  };
}

async function loadHistoryOrThrow(
  options: WorkflowOptions,
  runId: string,
): Promise<ReadonlyArray<WorkflowHistoryRecord>> {
  const records = await getSnapshotStoreFor(options).loadHistory(runId);
  if (records.length === 0) throw new WorkflowSnapshotNotFoundError(runId);
  return records;
}

export async function workflowHistory(
  options: WorkflowOptions,
  runId: string,
): Promise<ReadonlyArray<WorkflowCheckpoint>> {
  return (await loadHistoryOrThrow(options, runId)).map(toCheckpoint);
}

/** Locate the checkpoint before `stepIdx` and carry the earlier history over to `newRunId`. */
async function forkHistory(args: {
  options: WorkflowOptions;
  steps: ReadonlyArray<Step>;
  records: ReadonlyArray<WorkflowHistoryRecord>;
  stepIdx: number;
  newRunId: string;
}): Promise<WorkflowHistoryRecord | undefined> {
  const { options, steps, records, stepIdx, newRunId } = args;
  const before =
    stepIdx === 0
      ? undefined
      : records.find((r) => r.snapshot.currentStepId === steps[stepIdx - 1]?.id);
  if (stepIdx > 0 && before === undefined) {
    throw new WorkflowSnapshotNotFoundError(records[0]?.snapshot.runId ?? "");
  }
  const store = getSnapshotStoreFor(options);
  for (const [index, record] of records.slice(0, stepIdx).entries()) {
    await store.appendHistory(index, {
      ...record,
      snapshot: { ...record.snapshot, runId: newRunId },
    });
  }
  return before;
}

export async function rerunWorkflow<TO>(
  options: WorkflowOptions,
  steps: ReadonlyArray<Step>,
  opts: WorkflowRerunOptions,
): Promise<WorkflowRun<TO>> {
  const records = await loadHistoryOrThrow(options, opts.runId);
  const first = records[0] as WorkflowHistoryRecord;
  if (first.snapshot.workflowName !== options.name) {
    throw new WorkflowResumeWorkflowMismatchError(
      opts.runId,
      first.snapshot.workflowName,
      options.name,
    );
  }
  const stepIdx = steps.findIndex((s) => s.id === opts.stepId);
  if (stepIdx < 0) throw new WorkflowResumeStepNotFoundError(opts.stepId, options.name);
  const newRunId = mintRunId();
  const before = await forkHistory({ options, steps, records, stepIdx, newRunId });
  // The step before `stepId` supplies input and state; for the first step, the run's own.
  const startInput = before === undefined ? first.runInput : before.snapshot.accumulatedInput;
  const restored = before === undefined ? first.initialState : before.snapshot.state;
  const run = await executeWorkflow<unknown, TO>(
    options,
    steps.slice(stepIdx),
    opts.input !== undefined ? opts.input : startInput,
    {
      signal: opts.signal,
      runId: newRunId,
      initialStepResults: before?.snapshot.stepResults ?? [],
      skipInputValidation: stepIdx > 0,
      ...(restored !== undefined ? { restoredState: restored } : {}),
    } as InternalRunOpts,
  );
  return { ...run, rerunOf: { runId: opts.runId, stepId: opts.stepId } };
}
