/**
 * Owner: `internal/budget/` (4 of 6 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * Public type contract for the Budget enforcement primitive
 * (ADRs D375, D382-D387). The runtime facade lives in `budget.ts`.
 *
 * @public
 */

/**
 * Accounting scope for a budget.
 *
 * ONLY `"process"` is implemented, and `Budget.create` now REFUSES the other two with
 * `unimplemented_budget_scope`. It used to accept them: nothing outside the registry read `scope`, so
 * a caller asking for per-agent accounting silently got process-wide accounting — a cost control
 * reporting the wrong number, which is worse than the missing feature.
 *
 * The union is not narrowed to `"process"` here because that is a breaking change to a published
 * type and belongs to a major. Widening it back when the scopes are built is non-breaking.
 */
export type BudgetScope = "agent" | "call" | "process";

/**
 * Time window for a budget limit (D382 — UTC calendar-aligned).
 * - `1h` is relative (last 60 minutes).
 * - `1d` / `1w` / `30d` / `365d` are aligned to UTC calendar
 *   boundaries (UTC midnight / monday 00:00 UTC / 1st 00:00 UTC).
 */
export type BudgetWindow = "1h" | "1d" | "1w" | "30d" | "365d";

/**
 * Enforcement mode (D383).
 * - `audit`: log only, never throw, never block.
 * - `warn`: callbacks fire at 80/95/100% thresholds; no throw.
 * - `block`: preflightCheck throws `BudgetExceededError` BEFORE LLM call
 *   when would-exceed.
 */
export type BudgetMode = "audit" | "warn" | "block";

/** A single limit; stacked in an array (D384, ANY exceeded blocks). */
export interface BudgetLimit {
  readonly window: BudgetWindow;
  readonly limitUsd: number;
}

/** Threshold event emitted at 80% and 95% in `warn` and `block` modes. */
export interface BudgetThresholdEvent {
  readonly budgetName: string;
  readonly window: BudgetWindow;
  readonly threshold: 0.8 | 0.95;
  readonly spentUsd: number;
  readonly limitUsd: number;
}

/** Exceed event emitted at 100% across all modes. */
export interface BudgetExceedEvent {
  readonly budgetName: string;
  readonly window: BudgetWindow;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly mode: BudgetMode;
}

/** Options for `Budget.create`. */
export interface BudgetOptions {
  /**
   * Identifier. Must match grammar `^[a-z0-9][a-z0-9_-]*$` (EC-7);
   * empty/invalid → `ConfigurationError({ code: "invalid_budget_name" })`.
   */
  readonly name: string;
  readonly scope: BudgetScope;
  /**
   * Stacked limits — at least one is expected for `warn`/`block`. Empty
   * array (EC-19) is allowed → registry-only tracking, callbacks never
   * fire.
   */
  readonly limits: ReadonlyArray<BudgetLimit>;
  /** Default `warn` (D383). */
  readonly mode?: BudgetMode;
  /** Fires at 80% and 95% of any limit. Caller throws are isolated (EC-8). */
  readonly onThreshold?: (event: BudgetThresholdEvent) => void | Promise<void>;
  /** Fires at 100%. Caller throws are isolated (EC-8). */
  readonly onExceed?: (event: BudgetExceedEvent) => void | Promise<void>;
}

/** Returned by `Budget.create` and `Budget.get` — read-only view. */
export interface BudgetHandle {
  readonly name: string;
  readonly mode: BudgetMode;
  readonly scope: BudgetScope;
  readonly limits: ReadonlyArray<BudgetLimit>;
  /** Snapshot spend for the given window. */
  spentIn(window: BudgetWindow): number;
  /** Remaining USD before the given window's limit is reached. */
  remainingIn(window: BudgetWindow): number;
}

/** Per-window snapshot returned by `Budget.snapshot()`. */
export interface BudgetSnapshot {
  readonly name: string;
  readonly window: BudgetWindow;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly ratio: number;
  /** USD held by open `Budget.reserve` reservations. Not included in `spentUsd` or `ratio`. */
  readonly heldUsd: number;
}

/** An in-flight estimate held against a budget by `Budget.reserve`. */
export interface BudgetReservation {
  readonly budgetName: string;
  readonly estimatedUsd: number;
  /** Charge the actual cost (runs threshold callbacks as chargeAndCheckThresholds does) and drop the hold. Idempotent with release. */
  settle(actualUsd: number): Promise<void>;
  /** Drop the hold without charging. Idempotent. */
  release(): void;
}
