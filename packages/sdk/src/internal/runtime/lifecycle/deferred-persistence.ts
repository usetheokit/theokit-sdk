import type { Run, RunResult } from "../../../types/run.js";

/**
 * A deferred run is a promise that the pending call survives the process. So the caller's
 * `wait()` must not resolve `deferred` before the transcript write holding the unanswered
 * `tool_use` has finished, and a failed write must reach the caller instead of being logged.
 *
 * @internal
 */
export interface DeferredPersistence {
  /** The caller's view of the run: `wait()` holds a `deferred` result until the write settles. */
  readonly run: Run;
  /** The transcript write finished. Idempotent. */
  readonly persisted: () => void;
  /** The transcript write failed; a `deferred` `wait()` rejects with `cause`. Idempotent. */
  readonly failed: (cause: unknown) => void;
}

export function holdDeferredUntilPersisted(inner: Run): DeferredPersistence {
  let persisted!: () => void;
  let failed!: (cause: unknown) => void;
  const gate = new Promise<void>((resolve, reject) => {
    persisted = resolve;
    failed = reject;
  });
  gate.catch(() => undefined); // observed only by a caller that awaits a deferred result
  let held: Promise<RunResult> | undefined;
  const wait: Run["wait"] = () => {
    held ??= inner.wait().then(async (result) => {
      if (result.status === "deferred") await gate;
      return result;
    });
    return held;
  };
  const run = new Proxy(inner, {
    get(target, prop, receiver) {
      return prop === "wait" ? wait : Reflect.get(target, prop, receiver);
    },
  });
  return { run, persisted, failed };
}
