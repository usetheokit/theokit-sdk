/**
 * Public generic retry primitive (plan m0-foundation-expose-primitives, M0-3).
 *
 * Split into its own top-level module so `tsup` builds a dedicated
 * `@theokit/sdk/retry` sub-path entry, mirroring the `path-safety` pattern.
 * The default retry predicate is `isTransientError`, so retries follow the
 * SDK's own error classification.
 */

import { type RetryOptions, withRetry } from "./internal/retry/with-retry.js";

export type { RetryOptions };

/**
 * SE36 — replaces `withRetry` (ADR 0015 / ADR-P2).
 *
 * `Retry` is a static NAMESPACE, not a factory: the uniformity mandate spells every public entry
 * point `X.create(...)` so callers learn one verb, and twelve classes in this package follow it.
 *
 * This is the one place the mandate produced a false name, and it is fixed here rather than by
 * unwinding the mandate — consistency across a published API is worth more than the indirection.
 * `withRetry` is an EXECUTOR: it RUNS `fn` and resolves to `fn`'s result, so `create` named a
 * construction that never happens. `run` is the honest spelling and `create` is a deprecated alias,
 * because removing a published member is a major-version decision and the alias is what carries the
 * correction to a caller's editor in the meantime.
 *
 * @public
 */
export class Retry {
  private constructor() {}

  /** Run `fn`, retrying per `options`. Resolves to `fn`'s result. */
  static run<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
    return withRetry(fn, options);
  }

  /**
   * @deprecated Renamed to {@link Retry.run}. This never created anything — it runs `fn` and
   * resolves to its result — and the name said otherwise. Still honoured; removed in the next major.
   */
  static create<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
    return Retry.run(fn, options);
  }
}
