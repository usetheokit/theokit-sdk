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

/**
 * Settles once the transcript of a run that ended on deferred tool calls is durably written, or
 * rejects with the write's failure. A run that is not deferred settles it with nothing to wait for.
 *
 * @internal
 */
export interface DeferredDurability {
  readonly settled: Promise<void>;
  /** First call wins; a rejection is carried to `run.wait()` of a deferred run only. */
  settle(error?: unknown): void;
}

export function createDeferredDurability(): DeferredDurability {
  let resolve: () => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const settled = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  // No unhandled rejection when the run was not deferred and nobody awaits the gate.
  settled.catch(() => undefined);
  let done = false;
  return {
    settled,
    settle(error) {
      if (done) return;
      done = true;
      if (error === undefined) resolve();
      else reject(error);
    },
  };
}

/**
 * A view of `run` whose `wait()` does not resolve with `status: "deferred"` until the transcript
 * holding the unanswered `tool_use` is written, and rejects if that write failed.
 *
 * @internal
 */
export function withDeferredDurability(run: Run): Run {
  const durability = createDeferredDurability();
  const wait: Run["wait"] = async () => {
    const result = await run.wait();
    if (result.status === "deferred") await durability.settled;
    return result;
  };
  const view = new Proxy(run, {
    get(target, prop, receiver) {
      return prop === "wait" ? wait : Reflect.get(target, prop, receiver);
    },
  });
  gates.set(view, durability);
  innerRuns.set(view, innerRuns.get(run) ?? run);
  return view;
}

const gates = new WeakMap<Run, DeferredDurability>();

/** The gate of a view made by {@link withDeferredDurability}. */
export function durabilityOf(view: Run): DeferredDurability {
  return gates.get(view) as DeferredDurability;
}

/** Runs `task`, then settles the gate: with the task's failure if it threw, with nothing otherwise. */
export async function settleAfter(view: Run, task: () => Promise<void>) {
  const durability = durabilityOf(view);
  try {
    await task();
  } catch (err) {
    durability.settle(err);
    throw err;
  } finally {
    durability.settle();
  }
}
