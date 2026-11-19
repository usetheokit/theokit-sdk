/**
 * `WorkflowSet` — resume a run id on whichever of several workflows owns it.
 *
 * An app with several approval workflows hands the user one token (the run id). When the approval
 * comes back it does not know which workflow suspended that run. `WorkflowSet.resume` tries each
 * member in order and treats only the two "not this workflow" errors as a miss; every other error
 * (payload validation, a missing step, an I/O failure) is rethrown at once, unchanged.
 */
import { ConfigurationError } from "./errors.js";
import type { WorkflowDescription, WorkflowResumeOptions, WorkflowRun } from "./types/workflow.js";
import {
  WorkflowResumeWorkflowMismatchError,
  WorkflowSnapshotNotFoundError,
} from "./workflow-errors.js";

/** A committed workflow of any input type. Method bivariance lets `Workflow<{a: string}>` in. */
type CommittedWorkflow = WorkflowResumeOptions<never>["workflow"] & {
  describe(): WorkflowDescription;
};

/** @public */
export interface WorkflowSet {
  /**
   * Resume `runId` on the member that owns it. Resolves with the owner's `name` and the resumed run.
   * Rejects with `WorkflowSnapshotNotFoundError` when no member owns the run; any other error from a
   * member propagates unchanged and the remaining members are not tried.
   */
  resume<TO = unknown>(
    runId: string,
    payload?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{ name: string; run: WorkflowRun<TO> }>;
  /** Member workflow names, in the order given to `of`. */
  readonly names: readonly string[];
}

function isNotOwner(err: unknown): boolean {
  return (
    err instanceof WorkflowSnapshotNotFoundError ||
    err instanceof WorkflowResumeWorkflowMismatchError
  );
}

function memberNames(workflows: ReadonlyArray<CommittedWorkflow>): string[] {
  const seen = new Set<string>();
  return workflows.map((w) => {
    const { name } = w.describe();
    if (seen.has(name)) {
      throw new ConfigurationError(`WorkflowSet.of: two workflows share the name "${name}"`);
    }
    seen.add(name);
    return name;
  });
}

/** Resume on one member: the run, or `undefined` when this member does not own `runId`. */
async function tryResume<TO>(
  workflow: CommittedWorkflow,
  runId: string,
  payload: unknown,
  signal: AbortSignal | undefined,
): Promise<WorkflowRun<TO> | undefined> {
  try {
    const { resumeWorkflow } = await import("./internal/workflow/executor.js");
    return await resumeWorkflow<TO>({
      workflow,
      runId,
      ...(payload !== undefined ? { payload } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    if (isNotOwner(err)) return undefined;
    throw err;
  }
}

/**
 * Build a {@link WorkflowSet} with `WorkflowSet.of(workflows)`; throws `ConfigurationError` when two
 * members share a workflow name.
 *
 * @public
 */
export const WorkflowSet = {
  of(workflows: ReadonlyArray<CommittedWorkflow>): WorkflowSet {
    const members = [...workflows];
    const names = Object.freeze(memberNames(members));
    return {
      names,
      async resume<TO = unknown>(
        runId: string,
        payload?: unknown,
        options?: { signal?: AbortSignal },
      ) {
        for (const [i, workflow] of members.entries()) {
          const run = await tryResume<TO>(workflow, runId, payload, options?.signal);
          if (run !== undefined) return { name: names[i] as string, run };
        }
        throw new WorkflowSnapshotNotFoundError(runId);
      },
    };
  },
};
