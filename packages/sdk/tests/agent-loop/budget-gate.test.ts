/**
 * Unit tests for the budget pre-flight gate (architecture-review L1 fix).
 *
 * The agent loop calls `tracker.check()` before each iteration. The
 * BudgetTracker contract (types/budget-tracker.ts) says `check()`
 * RETURNS a decision; throwing is a contract violation. A budget guard is a
 * SAFETY/cost control, so when the tracker misbehaves the loop MUST fail
 * CLOSED (stop), not fail OPEN (proceed past budget). Regression guard.
 */

import { describe, expect, it } from "vitest";
import { evaluateBudgetGate } from "../../src/internal/agent-loop/budget-gate.js";
import type {
  BudgetCheck,
  BudgetTracker,
} from "../../src/internal/budget/tracker/budget-tracker.js";

function trackerReturning(check: BudgetCheck): BudgetTracker {
  return {
    track: () => {},
    check: () => check,
    getTotal: () => ({ tokens: 0 }),
  };
}

function trackerThatThrows(message: string): BudgetTracker {
  return {
    track: () => {},
    check: (): BudgetCheck => {
      throw new Error(message);
    },
    getTotal: () => ({ tokens: 0 }),
  };
}

describe("evaluateBudgetGate", () => {
  it("test_no_tracker_allows", () => {
    expect(evaluateBudgetGate(undefined)).toEqual({ allowed: true });
  });

  it("test_passes_through_allowed_decision", () => {
    const decision: BudgetCheck = { allowed: true };
    expect(evaluateBudgetGate(trackerReturning(decision))).toEqual(decision);
  });

  it("test_passes_through_denied_decision", () => {
    const decision: BudgetCheck = { allowed: false, reason: "token_limit", detail: "1000/1000" };
    expect(evaluateBudgetGate(trackerReturning(decision))).toEqual(decision);
  });

  it("test_fails_closed_when_check_throws", () => {
    const result = evaluateBudgetGate(trackerThatThrows("boom"));
    expect(result.allowed).toBe(false); // FAIL-CLOSED, not fail-open
    expect(result.reason).toBe("custom");
    expect(result.detail).toContain("boom");
  });
});

describe("evaluateBudgetGate cause", () => {
  it("keeps the thrown value as cause", () => {
    const original = new Error("nonsdk-boom-original");
    const decision = evaluateBudgetGate({
      track: () => {},
      check: (): BudgetCheck => {
        throw original;
      },
      getTotal: () => ({ tokens: 0 }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.cause).toBe(original);
  });
});
