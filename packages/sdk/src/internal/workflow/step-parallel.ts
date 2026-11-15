/**
 * Execute a `ParallelStep` — run N branches concurrently.
 *
 * - `errorPolicy: "fail-fast"` (default): first branch error aborts the rest
 *   via a derived AbortSignal; `WorkflowParallelError` aggregates failures.
 * - `errorPolicy: "collect"`: all branches complete; output is array of
 *   `{ ok: true, value } | { ok: false, error }`.
 *
 * Concurrency: bounded by `step.concurrency ?? branches.length` (D240). All
 * branches run inside the same `AsyncSemaphore`.
 *
 * EC-6 absorbed: empty `branches[]` returns `output: []` without error.
 *
 * @internal
 */

import type { ParallelStep, Step, StepResult } from "../../types/workflow.js";
import { WorkflowParallelError } from "../../workflow-errors.js";
import { createSemaphore } from "../concurrency/async-semaphore.js";
import { errToShape } from "./error-shape.js";
import type { StepExecution } from "./step-execution.js";

export async function runParallelStep(
  step: ParallelStep,
  input: unknown,
  exec: StepExecution,
): Promise<StepResult> {
  const { ctx } = exec;
  const startedAt = Date.now();
  const policy = step.errorPolicy ?? "fail-fast";
  const branchCount = step.branches.length;

  // EC-6: empty branches → empty output, no error.
  if (branchCount === 0) {
    return {
      stepId: step.id,
      kind: "parallel",
      status: "completed",
      attempts: 1,
      durationMs: Date.now() - startedAt,
      output: [],
    };
  }

  const concurrency = step.concurrency ?? branchCount;
  const sem = createSemaphore(Math.max(1, Math.min(concurrency, branchCount)));

  // Derived signal: aborts on the first failure (fail-fast) or the first cancelled branch (both).
  const failFastCtrl = new AbortController();
  const branchSignal = mergeSignals(ctx.signal, failFastCtrl.signal);

  // Gate each branch through the semaphore — acquire BEFORE running so the
  // permit cap is honored. (Eager-start would defeat concurrency limits.)
  const semBranchPromises = step.branches.map(async (branch, branchIdx) => {
    const release = await sem.acquire();
    try {
      // Queued branches must not dispatch after a cancel or fail-fast abort.
      if (branchSignal.aborted) throw new DOMException("Aborted", "AbortError");
      // Each branch runs under a signal of its own (the run's, merged with this step's) and
      // starts from an empty result history — the branches are siblings, not a sequence.
      return await runBranch(
        branch,
        input,
        { ...exec, ctx: { ...ctx, signal: branchSignal }, prevStepResults: [] },
        branchIdx,
      );
    } catch (err) {
      // Abort siblings at the initiating failure so it is the one reported.
      // Done before the permit is released so no queued branch starts afterwards.
      if (policy === "fail-fast" || isAbortError(err)) failFastCtrl.abort(err);
      throw err;
    } finally {
      release();
    }
  });

  if (policy === "fail-fast") {
    try {
      const outputs = await Promise.all(semBranchPromises);
      return {
        stepId: step.id,
        kind: "parallel",
        status: "completed",
        attempts: 1,
        durationMs: Date.now() - startedAt,
        output: outputs,
      };
    } catch (err) {
      failFastCtrl.abort(err);
      return await failFastFailure(semBranchPromises, step.id, startedAt, ctx.signal);
    }
  }

  // collect mode
  const settled = await Promise.allSettled(semBranchPromises);
  if (settled.some((s) => s.status === "rejected" && isAbortError(s.reason))) {
    return cancelledParallel(step.id, startedAt);
  }
  const outputs = settled.map((s) =>
    s.status === "fulfilled"
      ? { ok: true as const, value: s.value }
      : { ok: false as const, error: errToShape(s.reason) },
  );
  return {
    stepId: step.id,
    kind: "parallel",
    status: "completed",
    attempts: 1,
    durationMs: Date.now() - startedAt,
    output: outputs,
  };
}

async function failFastFailure(
  promises: ReadonlyArray<Promise<unknown>>,
  id: string,
  startedAt: number,
  parentSignal: AbortSignal,
): Promise<StepResult> {
  // Collect any settled rejections so the aggregate has all errors.
  const settled = await Promise.allSettled(promises);
  const errors = settled
    .filter((s): s is PromiseRejectedResult => s.status === "rejected")
    .map((s) => (s.reason instanceof Error ? s.reason : new Error(String(s.reason))));
  // Sibling aborts caused by fail-fast are not cancellation; keep the initiating failure.
  const real = errors.filter((e) => !isAbortError(e));
  if (parentSignal.aborted || real.length === 0) return cancelledParallel(id, startedAt);
  return {
    stepId: id,
    kind: "parallel",
    status: "failed",
    attempts: 1,
    durationMs: Date.now() - startedAt,
    error: errToShape(new WorkflowParallelError(real, id)),
    output: undefined,
  };
}

function cancelledParallel(id: string, startedAt: number): StepResult {
  return {
    stepId: id,
    kind: "parallel",
    status: "cancelled",
    attempts: 1,
    durationMs: Date.now() - startedAt,
    error: errToShape(new DOMException("parallel branch cancelled", "AbortError")),
  };
}

function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}

async function runBranch(
  branch: ReadonlyArray<Step>,
  input: unknown,
  exec: StepExecution,
  branchIdx: number,
): Promise<unknown> {
  const { dispatch } = exec;
  let acc: unknown = input;
  for (const inner of branch) {
    if (exec.ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const r = await dispatch(inner, acc, exec);
    if (r.status === "cancelled") {
      throw new DOMException(r.error?.message ?? "Aborted", "AbortError");
    }
    if (r.status === "failed") {
      throw new Error(
        `parallel branch ${branchIdx} step "${inner.id}" failed: ${r.error?.message ?? "unknown"}`,
      );
    }
    acc = r.output;
  }
  return acc;
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onAbortA = (): void => ctrl.abort(a.reason);
  const onAbortB = (): void => ctrl.abort(b.reason);
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return ctrl.signal;
}
