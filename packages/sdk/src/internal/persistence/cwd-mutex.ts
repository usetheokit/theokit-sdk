// Tail of the queue per key. Module-scoped on purpose — see `withCwdMutex` below, which is where
// the contract is documented. An entry is removed once its key has no call pending, so the Map
// holds only keys with work in flight, however many distinct keys were ever used.
const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier `withCwdMutex` call for the same `key` has settled, and return
 * what `fn` returns.
 *
 * Calls with the same key run strictly in the order they were made — FIFO, never concurrent.
 * Calls with different keys never wait on each other. The key is an opaque string: two callers
 * serialize against each other exactly when they pass equal keys, so a shared key IS the
 * contract, and a mismatched one silently buys no protection at all.
 *
 * A rejection does not poison the queue. The next waiter runs whether the previous `fn` fulfilled
 * or rejected, and the rejection is delivered only to the caller whose `fn` threw. This function
 * neither retries nor swallows: the returned promise rejects with whatever `fn` rejected with.
 *
 * There is no timeout and no cancellation. An `fn` that never settles blocks that key for the
 * lifetime of the process.
 *
 * **Scope — this is an in-process lock only.** State is a module-scoped Map, so it serializes
 * callers that share one module instance and nothing else. Two processes, two worker threads, or
 * two copies of the SDK resolved into the same tree do not see each other's queue. When the
 * resource is a file that other processes can also write, use `withFileLock` from
 * `./file-lock.ts` instead — it takes an OS-level lock and layers this mutex underneath, so it
 * gives both guarantees. Reach for `withCwdMutex` directly when the shared state is in memory, or
 * when the file is one only this process touches.
 *
 * Extracted packages (`@theokit/sdk-budget`, `@theokit/sdk-memory`) import this from
 * `@theokit/sdk` rather than reimplementing it, precisely so the Map is the same one: a per-package
 * copy would give each package its own queue and let their writes race.
 *
 * The Map is module-scoped, so nothing survives a process restart or a fresh module instance.
 * An entry is dropped as soon as its key has no call pending.
 * Signature and semantics will not change before sdk-core v3.0.
 *
 * @public
 */
export function withCwdMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn whether prev fulfilled or rejected
  // Save the new tail. It swallows the result so a failure here doesn't poison subsequent
  // waiters, and it removes the key once it is still the newest tail (no call is queued behind
  // it), so the Map holds entries only for keys with a call pending.
  const tail: Promise<unknown> = next.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return next;
}

/** Number of keys with a call pending. Test-only observation of the queue map. */
export function pendingCwdMutexKeyCount(): number {
  return tails.size;
}
