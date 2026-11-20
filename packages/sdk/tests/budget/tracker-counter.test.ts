/**
 * `createCounterBudgetTracker` reference impl tests
 * (SDK 2.0 Phase 2 / T2.1 — ADR D1 reference implementation).
 */

import { type BudgetTracker, createCounterBudgetTracker } from "@theokit/sdk";
import { describe, expect, it } from "vitest";

describe("createCounterBudgetTracker", () => {
  it("test_counter_satisfies_budget_tracker_contract", () => {
    const tracker: BudgetTracker = createCounterBudgetTracker();
    expect(typeof tracker.track).toBe("function");
    expect(typeof tracker.check).toBe("function");
    expect(typeof tracker.getTotal).toBe("function");
  });

  it("test_counter_sums_tokens_across_input_and_output", () => {
    const t = createCounterBudgetTracker();
    t.track({ tokens: 100, model: "x", type: "input" });
    t.track({ tokens: 50, model: "x", type: "output" });
    t.track({ tokens: 25, model: "x", type: "input" });
    expect(t.getTotal().tokens).toBe(175);
  });

  it("test_counter_check_allowed_when_under_token_limit", () => {
    const t = createCounterBudgetTracker({ maxTokens: 1000 });
    t.track({ tokens: 500, model: "x", type: "input" });
    expect(t.check().allowed).toBe(true);
  });

  it("test_counter_check_blocked_when_at_or_above_token_limit", () => {
    const t = createCounterBudgetTracker({ maxTokens: 100 });
    t.track({ tokens: 100, model: "x", type: "input" });
    const c = t.check();
    expect(c.allowed).toBe(false);
    expect(c.reason).toBe("token_limit");
    expect(c.detail).toContain("100");
  });

  it("test_counter_iteration_cap_blocks_after_n_calls", () => {
    const t = createCounterBudgetTracker({ maxIterations: 3 });
    expect(t.check().allowed).toBe(true);
    t.nextIteration();
    t.nextIteration();
    expect(t.check().allowed).toBe(true);
    t.nextIteration();
    expect(t.check().allowed).toBe(false);
    expect(t.check().reason).toBe("iteration_limit");
  });

  it("test_counter_silently_clamps_invalid_token_values", () => {
    const t = createCounterBudgetTracker();
    t.track({ tokens: 100, model: "x", type: "input" });
    t.track({ tokens: -50, model: "x", type: "input" }); // clamped to 0
    t.track({ tokens: Number.NaN, model: "x", type: "output" }); // clamped to 0
    t.track({ tokens: Number.POSITIVE_INFINITY, model: "x", type: "output" }); // clamped to 0
    expect(t.getTotal().tokens).toBe(100);
  });

  it("test_counter_no_limits_means_always_allowed", () => {
    const t = createCounterBudgetTracker();
    for (let i = 0; i < 100; i++) {
      t.track({ tokens: 10_000, model: "x", type: "output" });
      t.nextIteration();
    }
    expect(t.check().allowed).toBe(true);
    expect(t.getTotal().tokens).toBe(1_000_000);
    expect(t.getTotal().iterations).toBe(100);
  });

  it("test_counter_instances_are_independent", () => {
    const a = createCounterBudgetTracker();
    const b = createCounterBudgetTracker();
    a.track({ tokens: 100, model: "x", type: "input" });
    expect(a.getTotal().tokens).toBe(100);
    expect(b.getTotal().tokens).toBe(0);
  });
});
