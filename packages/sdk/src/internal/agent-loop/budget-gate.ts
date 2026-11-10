import type { BudgetCheck, BudgetTracker } from "../budget/tracker/budget-tracker.js";

/**
 * Pre-flight budget gate evaluated before each agent-loop iteration.
 *
 * The {@link BudgetTracker} contract says `check()` RETURNS a decision and
 * does not throw. A budget gate is a cost/safety control, so if a tracker
 * violates that contract by throwing, the loop MUST fail CLOSED (deny the
 * next iteration) rather than fail OPEN (silently proceed past budget).
 * This was the architecture-review L1 finding: the previous inline
 * `catch { decision = { allowed: true } }` let a broken tracker run forever.
 *
 * @internal
 */
export function evaluateBudgetGate(
  tracker: BudgetTracker | undefined,
): BudgetCheck & { readonly cause?: unknown } {
  if (tracker === undefined) return { allowed: true };
  try {
    return tracker.check();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Fail-closed: a budget guard that cannot evaluate denies the iteration.
    return {
      allowed: false,
      reason: "custom",
      detail: `budget_tracker_check_threw: ${message}`,
      // Keep the thrown value so the run's error can carry it as its cause.
      cause: error,
    };
  }
}
