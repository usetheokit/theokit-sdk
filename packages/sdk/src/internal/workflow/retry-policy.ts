/**
 * Retry wrapper with exponential backoff (ADR D237).
 *
 * `withRetry(fn, policy, signal)` retries on throw until success or
 * `maxAttempts` reached. Aborts mid-backoff when signal fires.
 * Non-retryable errors (by name) propagate immediately.
 *
 * @internal
 */

import type { RetryPolicy } from "../../types/workflow.js";

const DEFAULT_NON_RETRYABLE = ["AbortError", "WorkflowSnapshotNotFoundError", "ConfigurationError"];

interface BackoffConfig {
  init: number;
  coef: number;
  cap: number;
  nonRetryable: Set<string>;
  max: number;
}

function backoffConfigFromPolicy(policy: RetryPolicy): BackoffConfig {
  return {
    max: policy.maxAttempts,
    init: policy.initialBackoffMs ?? 1000,
    coef: policy.backoffCoefficient ?? 2.0,
    cap: policy.maximumBackoffMs ?? 30_000,
    nonRetryable: new Set(policy.nonRetryableErrors ?? DEFAULT_NON_RETRYABLE),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException(String(signal.reason ?? "Aborted"), "AbortError");
  }
}

function shouldRethrow(err: unknown, attempt: number, cfg: BackoffConfig): boolean {
  const errName = err instanceof Error ? err.name : "Error";
  // A cancellation is never retried, even when a custom nonRetryableErrors list omits AbortError.
  return errName === "AbortError" || cfg.nonRetryable.has(errName) || attempt === cfg.max;
}

async function tryOnce<T>(
  fn: () => Promise<T>,
  attempt: number,
  cfg: BackoffConfig,
  signal: AbortSignal,
): Promise<{ value: T; attempts: number } | { kind: "retry" }> {
  try {
    const value = await fn();
    return { value, attempts: attempt };
  } catch (err) {
    if (shouldRethrow(err, attempt, cfg)) throw err;
    await abortableSleep(Math.min(cfg.init * cfg.coef ** (attempt - 1), cfg.cap), signal);
    return { kind: "retry" };
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal,
): Promise<{ value: T; attempts: number }> {
  const cfg = backoffConfigFromPolicy(policy);
  for (let attempt = 1; attempt <= cfg.max; attempt += 1) {
    throwIfAborted(signal);
    const result = await tryOnce(fn, attempt, cfg, signal);
    if ("value" in result) return result;
  }
  // Unreachable: tryOnce throws on the final attempt when shouldRethrow returns true.
  throw new Error("withRetry: exhausted attempts without throwing");
}

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new DOMException(String(signal.reason ?? "Aborted"), "AbortError");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException(String(signal.reason ?? "Aborted"), "AbortError"));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
