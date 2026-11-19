import type { Run } from "../../../types/run.js";

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
export function withDeferredDurability(run: Run, durability: DeferredDurability): Run {
  const wait: Run["wait"] = async () => {
    const result = await run.wait();
    if (result.status === "deferred") await durability.settled;
    return result;
  };
  return new Proxy(run, {
    get(target, prop, receiver) {
      return prop === "wait" ? wait : Reflect.get(target, prop, receiver);
    },
  });
}

/** Runs `task`, then settles the gate: with the task's failure if it threw, with nothing otherwise. */
export async function settleAfter(durability: DeferredDurability, task: () => Promise<void>) {
  try {
    await task();
  } catch (err) {
    durability.settle(err);
    throw err;
  } finally {
    durability.settle();
  }
}
