/**
 * sdk-memory's CircuitBreaker export smoke test (iter 44 — first
 * Stage 3 file move).
 *
 * Validates the iter 44 hybrid copy of `internal/memory/circuit-breaker.ts`
 * from sdk-core. sdk-memory now ships its own canonical copy of the
 * `CircuitBreaker` class + `CircuitBreakerOptions` interface so future
 * rich providers (LanceDB-backed) can consume it without reaching into
 * sdk-core internals.
 *
 * sdk-core retains its copy for v1.x active-memory back-compat.
 * Both copies are byte-identical today; semver-major reconciliation
 * happens when Stage 3 source-move completes (iter 30 target).
 */

import type { CircuitBreakerOptions } from "@theokit/sdk-memory";
import { CircuitBreaker } from "@theokit/sdk-memory";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("sdk-memory CircuitBreaker export (iter 44)", () => {
  it("test_CircuitBreaker_class_exported", () => {
    expect(typeof CircuitBreaker).toBe("function");
    const cb = new CircuitBreaker();
    expect(cb).toBeInstanceOf(CircuitBreaker);
  });

  it("test_CircuitBreakerOptions_type_exported", () => {
    expectTypeOf<CircuitBreakerOptions>().toMatchTypeOf<{
      maxTimeouts?: number;
      cooldownMs?: number;
      now?: () => number;
    }>();
  });

  it("test_default_breaker_does_not_skip_on_fresh_key", () => {
    const cb = new CircuitBreaker();
    expect(cb.shouldSkip("agent-1")).toBe(false);
  });

  it("test_breaker_trips_after_maxTimeouts_consecutive_failures", () => {
    const now = 1000;
    const cb = new CircuitBreaker({
      maxTimeouts: 2,
      cooldownMs: 5000,
      now: () => now,
    });
    cb.recordTimeout("agent-1");
    expect(cb.shouldSkip("agent-1")).toBe(false); // 1/2
    cb.recordTimeout("agent-1");
    expect(cb.shouldSkip("agent-1")).toBe(true); // tripped
  });

  it("test_breaker_recovers_after_cooldown", () => {
    let now = 1000;
    const cb = new CircuitBreaker({
      maxTimeouts: 1,
      cooldownMs: 5000,
      now: () => now,
    });
    cb.recordTimeout("agent-1");
    expect(cb.shouldSkip("agent-1")).toBe(true);
    now = 1000 + 5001; // advance past cooldown
    expect(cb.shouldSkip("agent-1")).toBe(false);
  });

  it("test_recordSuccess_resets_counter", () => {
    const now = 1000;
    const cb = new CircuitBreaker({
      maxTimeouts: 2,
      cooldownMs: 5000,
      now: () => now,
    });
    cb.recordTimeout("agent-1");
    cb.recordSuccess("agent-1");
    cb.recordTimeout("agent-1");
    // Counter was reset by recordSuccess, so 1 timeout shouldn't trip.
    expect(cb.shouldSkip("agent-1")).toBe(false);
  });

  it("test_per_key_isolation_two_agents_no_share", () => {
    const now = 1000;
    const cb = new CircuitBreaker({
      maxTimeouts: 1,
      cooldownMs: 5000,
      now: () => now,
    });
    cb.recordTimeout("agent-A");
    expect(cb.shouldSkip("agent-A")).toBe(true);
    expect(cb.shouldSkip("agent-B")).toBe(false);
  });
});
