/**
 * `BudgetTracker` interface contract tests (SDK 2.0 Phase 2 / T2.1
 * foundation — ADR D1).
 *
 * These tests pin the public interface SHAPE. They do NOT exercise the
 * eventual Agent.create wiring (that lands in a subsequent iteration when
 * the actual extraction starts). Goal here: lock the contract so future
 * impls (default Budget today; `@theokit/sdk-budget` after Phase 2) can
 * conform without breaking changes.
 */

import type { BudgetCheck, BudgetTotal, BudgetTracker, BudgetUsageEvent } from "@theokit/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("BudgetTracker interface (Phase 2 / T2.1 foundation)", () => {
  it("test_event_shape — has tokens + model + type, optional at", () => {
    const ok: BudgetUsageEvent = {
      tokens: 42,
      model: "openai/gpt-4o-mini",
      type: "input",
    };
    expect(ok.tokens).toBe(42);
    expect(ok.type).toBe("input");

    const withTime: BudgetUsageEvent = {
      tokens: 10,
      model: "anthropic/claude-3-5-sonnet",
      type: "output",
      at: new Date().toISOString(),
    };
    expect(typeof withTime.at).toBe("string");
  });

  it("test_event_type_is_input_output_or_a_cache_bucket", () => {
    expectTypeOf<BudgetUsageEvent["type"]>().toEqualTypeOf<
      "input" | "output" | "cache_read" | "cache_write"
    >();
  });

  it("test_check_shape — allowed + optional reason + detail", () => {
    const passing: BudgetCheck = { allowed: true };
    expect(passing.allowed).toBe(true);

    const blocked: BudgetCheck = {
      allowed: false,
      reason: "budget_exceeded",
      detail: "USD limit hit at iteration 3",
    };
    expect(blocked.reason).toBe("budget_exceeded");
  });

  it("test_check_reason_enumerated_only", () => {
    expectTypeOf<NonNullable<BudgetCheck["reason"]>>().toEqualTypeOf<
      "budget_exceeded" | "iteration_limit" | "cost_limit" | "token_limit" | "custom"
    >();
  });

  it("test_total_shape — tokens required, costUsd + iterations optional", () => {
    const total: BudgetTotal = { tokens: 100, costUsd: 0.05, iterations: 3 };
    expect(total.tokens).toBe(100);
    expect(total.costUsd).toBe(0.05);

    const minimal: BudgetTotal = { tokens: 50 };
    expect(minimal.costUsd).toBeUndefined();
  });

  it("test_tracker_shape — has track, check, getTotal", () => {
    const noopTracker: BudgetTracker = {
      track: () => undefined,
      check: () => ({ allowed: true }),
      getTotal: () => ({ tokens: 0 }),
    };
    expect(typeof noopTracker.track).toBe("function");
    expect(typeof noopTracker.check).toBe("function");
    expect(typeof noopTracker.getTotal).toBe("function");

    // Functional smoke: noop tracker conforms to the contract.
    noopTracker.track({ tokens: 5, model: "x", type: "input" });
    expect(noopTracker.check().allowed).toBe(true);
    expect(noopTracker.getTotal().tokens).toBe(0);
  });

  it("test_track_returns_void_not_promise — hot path discipline", () => {
    // Sync invariant — track() runs on every iteration; an async impl would
    // bloat the agent loop with floating promises. This type-test pins the
    // contract.
    type TrackReturn = ReturnType<BudgetTracker["track"]>;
    expectTypeOf<TrackReturn>().toEqualTypeOf<void>();
  });

  it("test_tracker_implementations_can_aggregate — example real impl", () => {
    let totalTokens = 0;
    const aggregator: BudgetTracker = {
      track: (e) => {
        totalTokens += e.tokens;
      },
      check: () => ({
        allowed: totalTokens < 1000,
        ...(totalTokens >= 1000 ? { reason: "token_limit" as const } : {}),
      }),
      getTotal: () => ({ tokens: totalTokens }),
    };

    aggregator.track({ tokens: 100, model: "m", type: "input" });
    aggregator.track({ tokens: 200, model: "m", type: "output" });
    expect(aggregator.getTotal().tokens).toBe(300);
    expect(aggregator.check().allowed).toBe(true);

    aggregator.track({ tokens: 900, model: "m", type: "output" });
    expect(aggregator.getTotal().tokens).toBe(1200);
    expect(aggregator.check().allowed).toBe(false);
    expect(aggregator.check().reason).toBe("token_limit");
  });
});
