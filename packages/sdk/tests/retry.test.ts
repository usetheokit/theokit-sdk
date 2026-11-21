import { describe, expect, it, vi } from "vitest";

import { AuthenticationError, ConfigurationError, RateLimitError } from "../src/errors.js";
import { Retry } from "../src/retry.js";

/**
 * M0-3 (plan m0-foundation-expose-primitives, T4.1) — generic `Retry`.
 *
 * Contract (sealed by these tests):
 *   - retries transient failures with exponential backoff (deterministic via
 *     injected `sleep` + `rng` — no real timers)
 *   - default `isRetryable` is `isTransientError`
 *   - rethrows non-retryable errors immediately (no sleep)
 *   - propagates an aborted sleep without re-invoking `fn`
 */
describe("Retry", () => {
  it("test_withRetry_succeeds_first_attempt_no_sleep", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => "ok");
    expect(await Retry.create(fn, { sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("test_withRetry_retries_until_success", async () => {
    let calls = 0;
    const value = await Retry.create(
      async () => {
        calls += 1;
        if (calls < 3) throw new RateLimitError("rate limited");
        return calls;
      },
      { sleep: async () => {}, retries: 5 },
    );
    expect(value).toBe(3);
  });

  it("test_withRetry_uses_injected_sleep_with_backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await Retry.create(
      async () => {
        calls += 1;
        if (calls < 3) throw new RateLimitError("rate limited");
        return "done";
      },
      {
        retries: 5,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        rng: () => 1,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(sleeps).toEqual([100, 200]);
  });

  it("test_withRetry_rethrows_non_retryable_immediately", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new AuthenticationError("bad key");
    });
    await expect(Retry.create(fn, { sleep })).rejects.toBeInstanceOf(AuthenticationError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("test_withRetry_default_isRetryable_uses_isTransientError", async () => {
    // RateLimitError is transient -> retried; AuthenticationError is not.
    let rlCalls = 0;
    await expect(
      Retry.create(
        async () => {
          rlCalls += 1;
          throw new RateLimitError("rl");
        },
        { retries: 2, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(rlCalls).toBe(3); // 1 + 2 retries

    let authCalls = 0;
    await expect(
      Retry.create(
        async () => {
          authCalls += 1;
          throw new AuthenticationError("auth");
        },
        { retries: 2, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(authCalls).toBe(1); // not retried
  });

  it("test_withRetry_aborts_mid_sleep", async () => {
    const fn = vi.fn(async () => {
      throw new RateLimitError("rl");
    });
    await expect(
      Retry.create(fn, {
        retries: 5,
        sleep: async () => {
          throw new Error("aborted");
        },
      }),
    ).rejects.toThrow("aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("test_withRetry_throws_on_invalid_retries", async () => {
    // B-079 — was a bare `.rejects.toThrow()`. `resolveRetryOptions` throws
    // `ConfigurationError` with `code: "invalid_retry_config"`
    // (src/internal/retry/with-retry.ts).
    await expect(Retry.create(async () => "x", { retries: -1 })).rejects.toThrow(
      ConfigurationError,
    );
    await expect(Retry.create(async () => "x", { retries: -1 })).rejects.toMatchObject({
      code: "invalid_retry_config",
    });
    await expect(Retry.create(async () => "x", { retries: 1.5 })).rejects.toThrow(
      ConfigurationError,
    );
    await expect(Retry.create(async () => "x", { retries: 1.5 })).rejects.toMatchObject({
      code: "invalid_retry_config",
    });
    await expect(
      Retry.create(async () => "x", { retries: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      Retry.create(async () => "x", { retries: Number.POSITIVE_INFINITY }),
    ).rejects.toMatchObject({ code: "invalid_retry_config" });
  });
});

describe("Retry.run — the honest spelling of Retry.create", () => {
  /**
   * `Retry` is a static namespace under a uniformity mandate that spells every public entry point
   * `X.create(...)`, and this is the one place that produced a false name: `withRetry` RUNS `fn` and
   * resolves to its result, so `create` named a construction that never happens.
   *
   * Fixed by adding the honest name rather than by unwinding the mandate — twelve classes follow it
   * and consistency across a published API is worth more than the indirection. `create` stays as a
   * deprecated alias because removing a published member is a major-version decision.
   */
  it("runs the function and resolves to its result", async () => {
    let calls = 0;
    await expect(
      Retry.run(async () => {
        calls += 1;
        return "result";
      }),
    ).resolves.toBe("result");
    expect(calls, "it RUNS — the thing `create` did not name").toBe(1);
  });

  it("retries a transient failure, like the alias it replaces", async () => {
    let attempts = 0;
    const out = await Retry.run(
      async () => {
        attempts += 1;
        if (attempts < 3)
          throw new RateLimitError("429", { metadata: { statusCode: 429 } as never });
        return "eventually";
      },
      { retries: 5, initialDelayMs: 1 },
    );
    expect(out).toBe("eventually");
    expect(attempts).toBe(3);
  });

  it("create is the same call, so nothing breaks before the next major", async () => {
    const viaAlias = await Retry.create(async () => 42);
    const viaRun = await Retry.run(async () => 42);
    expect(viaAlias).toBe(viaRun);
  });
});
