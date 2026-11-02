/**
 * The workflow error hierarchy — runtime classes, deliberately NOT in `types/`.
 *
 * `types/index.ts` calls itself "the canonical public contract" and re-exports every sibling with
 * `export type *`, which cannot carry a value; `.dependency-cruiser.cjs` restates the same rule as
 * "src/types/* are pure type definitions". These twelve classes lived in `types/workflow.ts` anyway
 * and reached consumers only because the DTS rollup hoists a declaration the runtime bundle never
 * emitted — the shape that shipped #279 for `isValidTaskId`. `tests/lint/types-are-types-only.test.ts`
 * is what stops it recurring.
 *
 * The home mirrors `task-errors.ts`: errors for one public surface, next to it, at the src root.
 * Re-exported by name from `workflow.ts`, so `@theokit/sdk/workflow` is unchanged.
 *
 * @public
 */

import { TheokitAgentError } from "./errors-base.js";
import type { WorkflowRun } from "./types/workflow.js";

/**
 * Thrown by `.commit()` when one step id appears twice anywhere in the workflow — including inside a
 * parallel branch, a branch predicate, the fallback, and the inner step of a `foreach` or `dowhile`.
 *
 * Ids address steps in snapshots and on resume, so this is refused at build time rather than
 * discovered mid-run. Workflows nested with `workflowStep()` are exempt: the child runs in its own
 * executor with its own id-space, so its ids cannot collide with the parent's.
 */
export class WorkflowDuplicateStepIdError extends TheokitAgentError {
  override readonly name = "WorkflowDuplicateStepIdError";
  constructor(public readonly stepId: string) {
    super(`Duplicate step id "${stepId}" in workflow.`, {
      code: "workflow_duplicate_step_id",
      isRetryable: false,
    });
  }
}

/**
 * SE27 — the whole-workflow `inputSchema` rejected `run(input)` (before step 1).
 * `detail` is a pre-formatted issues summary (a string, NOT Zod's `ZodIssue[]`).
 */
export class WorkflowInputError extends TheokitAgentError {
  override readonly name = "WorkflowInputError";
  constructor(
    public readonly workflowName: string,
    public readonly detail: string,
  ) {
    super(`Workflow "${workflowName}" input failed schema validation: ${detail}`, {
      code: "workflow_input_invalid",
      isRetryable: false,
    });
  }
}

/**
 * SE27 — the whole-workflow `outputSchema` rejected the final output (on `completed`).
 * `detail` is a pre-formatted issues summary (a string, NOT Zod's `ZodIssue[]`).
 */
export class WorkflowOutputError extends TheokitAgentError {
  override readonly name = "WorkflowOutputError";
  constructor(
    public readonly workflowName: string,
    public readonly detail: string,
  ) {
    super(`Workflow "${workflowName}" output failed schema validation: ${detail}`, {
      code: "workflow_output_invalid",
      isRetryable: false,
    });
  }
}

/**
 * SE29 — `WorkflowOptions.stateSchema` rejected an `initialState` or a
 * `setState(next)` call. `detail` is a pre-formatted issues summary.
 */
export class WorkflowStateError extends TheokitAgentError {
  override readonly name = "WorkflowStateError";
  constructor(
    public readonly workflowName: string,
    public readonly detail: string,
  ) {
    super(`Workflow "${workflowName}" state failed schema validation: ${detail}`, {
      code: "workflow_state_invalid",
      isRetryable: false,
    });
  }
}

/**
 * SE30 — a nested workflow (via `workflowStep`) did not `complete`. A nested
 * `suspended` is NOT resumable in v1 (resume continues AFTER the step, so the
 * child would be skipped) — restructure with a top-level suspend. A nested
 * `failed`/`cancelled` fails the parent step with the child's error attached.
 */
export class WorkflowNestedError extends TheokitAgentError {
  override readonly name = "WorkflowNestedError";
  constructor(
    public readonly stepId: string,
    public readonly childName: string,
    public readonly childStatus: Exclude<WorkflowRun["status"], "completed">,
    public readonly childError?: { name: string; message: string },
  ) {
    super(
      `Nested workflow "${childName}" (step "${stepId}") ended with status "${childStatus}"${
        childStatus === "suspended"
          ? " — nested suspend/resume is not supported in v1 (use a top-level suspend)"
          : ""
      }${childError ? `: ${childError.name}: ${childError.message}` : ""}`,
      // Reconstruct a synthetic Error from the serialized child-error shape so
      // debuggers surface the nested cause chain — the original Error instance is
      // lost at the WorkflowRun serialization boundary, so this is the best
      // achievable without changing the run protocol.
      {
        code: "workflow_nested_failed",
        isRetryable: false,
        ...(childError
          ? { cause: Object.assign(new Error(childError.message), { name: childError.name }) }
          : {}),
      },
    );
  }
}

/**
 * Thrown out of `Workflow.run()` — one of the few workflow failures that rejects instead of arriving
 * as `run.status === "failed"` — when the committed workflow already has a run in flight under the
 * same run id.
 *
 * The lock key pairs the id minted at `.commit()` with the run id, not `WorkflowOptions.name`, so
 * two workflows sharing a name are independent and concurrent runs with distinct minted ids never
 * collide. In practice this only fires when a caller pins `WorkflowRunOptions.runId`, or resumes a
 * run id that is still executing. The registry is an in-process map: a crash releases every lock, and
 * it says nothing about runs in other processes.
 */
export class WorkflowAlreadyRunningError extends TheokitAgentError {
  override readonly name = "WorkflowAlreadyRunningError";
  constructor(
    public readonly workflowName: string,
    public readonly runId: string,
  ) {
    super(`Workflow "${workflowName}" run "${runId}" already in-flight.`, {
      code: "workflow_already_running",
      isRetryable: true,
    });
  }
}

/**
 * Thrown by `Workflow.resume()` when no snapshot exists for the given run id.
 *
 * The message suggests configuring persistence, which is the common cause but not the only one. The
 * run may never have suspended; it may have suspended under the default memory backend in a process
 * that has since exited; or the snapshot may already have been consumed, since resume deletes it
 * before re-entering the executor and a second resume of the same run id lands here.
 */
export class WorkflowSnapshotNotFoundError extends TheokitAgentError {
  override readonly name = "WorkflowSnapshotNotFoundError";
  constructor(public readonly runId: string) {
    super(`No snapshot found for runId "${runId}". Configure persistence to enable resume.`, {
      code: "workflow_snapshot_not_found",
      isRetryable: false,
    });
  }
}

/**
 * Raised when a `dowhile` step's condition kept returning true past `maxIterations` (default 100).
 *
 * It does not escape `run()`: the step fails, the run ends `status: "failed"`, and the error reaches
 * the caller flattened as `run.error` with `name: "WorkflowMaxIterationsExceededError"` — match on
 * the name, the instance does not survive. The guard is evaluated before each iteration, so the inner
 * step runs at most `maxIterations` times; raising the ceiling is a `maxIterations` on the step, and
 * there is no global default to change.
 */
export class WorkflowMaxIterationsExceededError extends TheokitAgentError {
  override readonly name = "WorkflowMaxIterationsExceededError";
  constructor(
    public readonly stepId: string,
    public readonly maxIterations: number,
  ) {
    super(`Step "${stepId}" exceeded max iterations (${maxIterations}).`, {
      code: "workflow_max_iterations_exceeded",
      isRetryable: false,
    });
  }
}

/** EC-4 absorbed — JSON.stringify failed on snapshot payload. */
export class WorkflowNotSerializableError extends TheokitAgentError {
  override readonly name = "WorkflowNotSerializableError";
  constructor(
    public readonly stepId: string,
    public readonly underlying: Error,
  ) {
    super(
      `Workflow snapshot at step "${stepId}" failed to serialize as JSON: ${underlying.message}. ` +
        `Persisted snapshots support only JSON-serializable values (no BigInt, no circular refs, no class instances with cycles).`,
      { code: "workflow_not_serializable", isRetryable: false },
    );
  }
}

/** EC-8 absorbed — `currentStepId` from snapshot not found in resumed workflow. */
export class WorkflowResumeStepNotFoundError extends TheokitAgentError {
  override readonly name = "WorkflowResumeStepNotFoundError";
  constructor(
    public readonly stepId: string,
    public readonly workflowName: string,
  ) {
    super(
      `Cannot resume: step "${stepId}" not found in workflow "${workflowName}". ` +
        `The Workflow definition diverged from the snapshot.`,
      { code: "workflow_resume_step_not_found", isRetryable: false },
    );
  }
}

/**
 * Thrown by `Workflow.resume()` (and so by a `workflowResumeTool` tool) when the snapshot for the run
 * id was written by a workflow of another name. The snapshot is left in the store, so the workflow
 * that suspended the run can still resume it.
 *
 * Without this check the default store, one process-global memory store, would let workflow B run
 * its own tail on workflow A's accumulated input whenever both declare a step with the suspended id.
 * `name` is a label, not an identity: two workflows that share a name are not told apart here.
 */
export class WorkflowResumeWorkflowMismatchError extends TheokitAgentError {
  override readonly name = "WorkflowResumeWorkflowMismatchError";
  constructor(
    public readonly runId: string,
    public readonly snapshotWorkflowName: string,
    public readonly workflowName: string,
  ) {
    super(
      `Cannot resume run "${runId}" with workflow "${workflowName}": ` +
        `the run was suspended by workflow "${snapshotWorkflowName}".`,
      { code: "workflow_resume_workflow_mismatch", isRetryable: false },
    );
  }
}

/**
 * Aggregate failure from parallel branches.
 *
 * THE ONE PUBLIC WORKFLOW ERROR STILL OUTSIDE THE SDK HIERARCHY, deliberately. Its ten siblings were
 * reparented onto `TheokitAgentError` so `isTransientError` — and therefore `Retry.create`'s default
 * predicate — can see them at all. This one cannot follow without ceasing to be an `AggregateError`,
 * and `instanceof AggregateError` plus the standard `errors` array is the whole reason a caller
 * catches it: they want the branch failures, not a single message.
 *
 * The cost is stated rather than hidden: `isTransientError(err)` is `false` for this class, so a
 * parallel step whose branches failed transiently is not retried by the SDK's own helper. Inspect
 * `err.errors` and decide per branch — which is what an aggregate asks of a caller anyway, since
 * "should this be retried" has no single answer when the branches failed for different reasons.
 */
export class WorkflowParallelError extends AggregateError {
  override readonly name = "WorkflowParallelError";
  constructor(
    errors: ReadonlyArray<Error>,
    public readonly stepId: string,
  ) {
    super(errors, `${errors.length} branch(es) failed in parallel step "${stepId}".`);
  }
}

/** D238 — saga engine not yet implemented. */
export class WorkflowCompensateNotImplementedError extends TheokitAgentError {
  override readonly name = "WorkflowCompensateNotImplementedError";
  constructor(public readonly stepId: string) {
    super(
      `Step "${stepId}" defines compensate, but saga engine is deferred to v1.2. ` +
        `Remove compensate or implement rollback manually.`,
      { code: "workflow_compensate_not_implemented", isRetryable: false },
    );
  }
}
