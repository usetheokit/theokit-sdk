/**
 * B-498 — `AgentOptions.throwOnError` on the run a caller receives.
 *
 * The caller gets a view of the run whose `wait()` rejects with `result.error.cause`, the typed
 * `TheokitAgentError`, when the run ended `status: "error"` with an error detail. The SDK's own
 * readers (the post-run lifecycle, task wrapping, the cloud mutex hold) read through
 * {@link readRunResolving}, which always resolves, so the lifecycle still reaches its `postRun`
 * hook on a failed run.
 *
 * The view is lazy and memoised, like `wrap-output-run.ts`: no rejected promise exists until
 * somebody calls `wait()`, so a caller who never awaits a failed run sees no unhandled rejection.
 *
 * @internal
 */

import type { Run, RunResult } from "../../../types/run.js";

/** Caller's view → the run it wraps. Lets {@link readRunResolving} read below a view. */
const innerRuns = new WeakMap<Run, Run>();

/** Wrap `run` so its `wait()` rejects with the typed cause of a failed run. */
export function wrapRunWithThrowOnError(run: Run): Run {
  let settled: Promise<RunResult> | undefined;
  const rejectingWait: Run["wait"] = () => {
    settled ??= run.wait().then(rejectOnTypedFailure);
    return settled;
  };
  const view = new Proxy(run, {
    get(target, prop, receiver) {
      if (prop === "wait") return rejectingWait;
      return Reflect.get(target, prop, receiver);
    },
  });
  innerRuns.set(view, run);
  return view;
}

/** Read a run's result without the caller's `throwOnError` rejection. */
export function readRunResolving(run: Run): Promise<RunResult> {
  return (innerRuns.get(run) ?? run).wait();
}

function rejectOnTypedFailure(result: RunResult): RunResult {
  const cause = result.status === "error" ? result.error?.cause : undefined;
  if (cause !== undefined) throw cause;
  return result;
}
