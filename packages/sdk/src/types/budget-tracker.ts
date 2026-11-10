/**
 * Owner: `internal/budget/tracker/` (1 of 1 importers). Derived from the import graph, not
 * declared — `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * `BudgetTracker` — runtime contract for budget/usage tracking in the
 * agent loop (SDK 2.0 Phase 2 / T2.1 — ADR D1 interface inversion).
 *
 * This interface is the FOUNDATION for the eventual extraction of the
 * Budget subsystem to `@theokit/sdk-budget`. The kernel depends on this
 * contract (not on `UsageAccumulator` / `IterationBudget` concrete classes)
 * so the implementation can move to a separate package without circular
 * imports.
 *
 * DIP-correct home (SE46): the contract types live in the domain `types/`
 * layer; the application-layer implementation
 * (`internal/budget/tracker/budget-tracker.ts`) re-exports them for
 * back-compat while owning the concrete trackers.
 *
 * @public — surface-level interface; impl is internal-but-replaceable.
 */

/** Single usage event recorded during one LLM call. */
export interface BudgetUsageEvent {
  /** Token count for this event. */
  readonly tokens: number;
  /** Provider/model identifier (e.g., `"openai/gpt-4o-mini"`). */
  readonly model: string;
  /**
   * Whether this is an input (uncached prompt), output (completion), `cache_read` (prompt tokens
   * served from the provider's cache) or `cache_write` (prompt tokens written to it) measurement.
   * A tracker that has no separate rate for the cache types should treat them as input.
   */
  readonly type: "input" | "output" | "cache_read" | "cache_write";
  /** Optional ISO 8601 timestamp; defaults to now() if omitted. */
  readonly at?: string;
}

/** Decision the tracker returns on each iteration / pre-flight check. */
export interface BudgetCheck {
  /** Whether the agent loop is allowed to proceed. */
  readonly allowed: boolean;
  /**
   * When `allowed` is false, names the reason in a stable, codemod-friendly
   * form. Consumers map this to retry / surface to user / abort behavior.
   */
  readonly reason?: "budget_exceeded" | "iteration_limit" | "cost_limit" | "token_limit" | "custom";
  /** Free-form details for logs / diagnostics. */
  readonly detail?: string;
}

/** Aggregate snapshot of usage so far. */
export interface BudgetTotal {
  /** Sum of all input + output tokens. */
  readonly tokens: number;
  /** USD cost when pricing data is available; `undefined` otherwise. */
  readonly costUsd?: number;
  /** Iteration count if the impl tracks it. */
  readonly iterations?: number;
}

/**
 * The kernel-facing contract. Implementations live OUTSIDE the agent loop
 * (in `@theokit/sdk-budget` after Phase 2 / in `internal/budget/` until then).
 *
 * Implementations MUST be:
 *   - **Synchronous** — every method returns a value, never a Promise.
 *     `track()` is on the hot path (called on every iteration); async would
 *     bloat the loop with floating promises and force every call site to
 *     await.
 *   - **Non-throwing in track()** — record-only semantics. Validation
 *     failures bubble up via `check()` instead.
 */
export interface BudgetTracker {
  /** Record a single usage event. MUST be synchronous and non-throwing. */
  track(event: BudgetUsageEvent): void;
  /** Pre-flight check before the next iteration. */
  check(): BudgetCheck;
  /** Snapshot of accumulated totals (for telemetry / final reporting). */
  getTotal(): BudgetTotal;
  /**
   * Advance the iteration counter by one. Called by the agent loop ONCE per
   * completed turn (M1-1) so that trackers which gate on `maxIterations`
   * (e.g. `createCounterBudgetTracker`) actually halt. OPTIONAL: trackers that
   * only gate on tokens/USD omit it and the loop no-ops via optional chaining.
   * MUST be synchronous and non-throwing.
   */
  nextIteration?(): void;
}
