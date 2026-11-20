/**
 * `WorkflowSet`: resume a run id on whichever committed workflow owns it.
 *
 * @public
 */

import { ConfigurationError } from "./errors.js";
import type { WorkflowResumeOptions, WorkflowRun } from "./types/workflow.js";
import {
  WorkflowResumeWorkflowMismatchError,
  WorkflowSnapshotNotFoundError,
} from "./workflow-errors.js";

/** A committed workflow of any input and output type. */
// Structural on purpose: importing the `Workflow` class here would make `workflow.ts` <-> this file a cycle.
type AnyCommittedWorkflow = WorkflowResumeOptions<never>["workflow"] & {
  readonly __options: { readonly name: string };
};

/** A fixed set of committed workflows that share one resume entry point. */
export interface WorkflowSet {
  /**
   * Resume `runId` on the member that owns it. A member that has no snapshot for the id
   * (`WorkflowSnapshotNotFoundError`) or whose snapshot belongs to another workflow
   * (`WorkflowResumeWorkflowMismatchError`) is skipped; any other error is rethrown at once.
   * When no member owns the run, throws `WorkflowSnapshotNotFoundError(runId)`.
   */
  resume<TO = unknown>(
    runId: string,
    payload?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{ name: string; run: WorkflowRun<TO> }>;
  /** Member workflow names, in the order given to `WorkflowSet.of`. */
  readonly names: readonly string[];
}

/** Factory for {@link WorkflowSet}. */
export const WorkflowSet: {
  /** Throws `ConfigurationError` when two members share a workflow name. */
  of(workflows: ReadonlyArray<AnyCommittedWorkflow>): WorkflowSet;
} = {
  of(workflows) {
    const members = workflows.map((workflow) => ({ workflow, name: workflow.__options.name }));
    const seen = new Set<string>();
    for (const { name } of members) {
      if (seen.has(name)) {
        throw new ConfigurationError(`WorkflowSet.of: two workflows share the name "${name}".`);
      }
      seen.add(name);
    }
    return {
      names: members.map((m) => m.name),
      resume: (runId, payload, options) => resumeOnOwner(members, runId, payload, options),
    };
  },
};

const NOT_THIS_WORKFLOW = [WorkflowSnapshotNotFoundError, WorkflowResumeWorkflowMismatchError];

async function resumeOnOwner<TO>(
  members: ReadonlyArray<{ workflow: AnyCommittedWorkflow; name: string }>,
  runId: string,
  payload: unknown,
  options: { signal?: AbortSignal } | undefined,
): Promise<{ name: string; run: WorkflowRun<TO> }> {
  const { resumeWorkflow } = await import("./internal/workflow/executor.js");
  for (const { workflow, name } of members) {
    try {
      const run = await resumeWorkflow<TO>({
        workflow,
        runId,
        payload,
        signal: options?.signal,
      });
      return { name, run };
    } catch (err) {
      if (!NOT_THIS_WORKFLOW.some((c) => err instanceof c)) throw err;
    }
  }
  throw new WorkflowSnapshotNotFoundError(runId);
}
