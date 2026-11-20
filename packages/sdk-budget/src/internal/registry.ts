/**
 * Internal Budget registry — keeps live `BudgetOptions` per name.
 * Singleton; no persistence (D385).
 *
 * @internal
 */

import {
  type BudgetHandle,
  type BudgetMode,
  type BudgetOptions,
  type BudgetSnapshot,
  type BudgetWindow,
  ConfigurationError,
} from "@theokit/sdk";
import { spentIn } from "./ledger.js";

const NAME_GRAMMAR = /^[a-z0-9][a-z0-9_-]*$/;

const registry = new Map<string, BudgetOptions>();

function validateBudgetName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new ConfigurationError("Budget name must be a non-empty string", {
      code: "invalid_budget_name",
    });
  }
  if (!NAME_GRAMMAR.test(name)) {
    throw new ConfigurationError(
      `Budget name "${name}" must match ^[a-z0-9][a-z0-9_-]*$ (lowercase + dash/underscore, start alphanumeric)`,
      { code: "invalid_budget_name" },
    );
  }
}

/**
 * Register a budget under `opts.name` and return its live handle.
 *
 * ```ts
 * const b = createBudget({ name: "daily", mode: "block", limits: [{ window: "1d", limitUsd: 5 }] });
 * ```
 *
 * THROWS `ConfigurationError(code: "invalid_budget_name")` in two cases: a name that does not match
 * `^[a-z0-9][a-z0-9_-]*$` (lowercase only — `"Daily"` and `"my.budget"` are rejected), and a name
 * already registered. Duplicate registration is deliberately an error rather than an idempotent
 * return, so a second `createBudget("daily", …)` with different limits cannot silently win.
 *
 * Registering does NOT reset spend. The ledger is keyed by NAME and outlives the registry entry, so
 * re-creating a budget after `deleteBudget` inherits everything charged under that name — a
 * config reload keeps enforcing the day's spend, which is usually right and is a surprise if you
 * expected a fresh start.
 *
 * Process-local and non-persistent: nothing survives a restart, so re-create budgets at startup.
 * `mode` defaults to `"warn"` (see {@link defaultMode}) — a budget created without one observes and
 * does not block.
 */
export function createBudget(opts: BudgetOptions): BudgetHandle {
  // EC-7: name validation
  validateBudgetName(opts.name);
  if (registry.has(opts.name)) {
    // EC-16: duplicate throws (vs Task.submit idempotent return)
    throw new ConfigurationError(`Budget "${opts.name}" already exists`, {
      code: "invalid_budget_name",
    });
  }
  registry.set(opts.name, opts);
  return buildHandle(opts);
}

/**
 * The live handle for a registered budget, or `undefined` when the name is unknown.
 *
 * `undefined` is the honest answer for "never created" — it does NOT mean "zero spend". A budget
 * that exists but has not been charged returns a handle whose `spentIn(...)` is 0, and the two are
 * different facts: the first means nothing is enforcing a limit.
 *
 * The registry is per-PROCESS and holds no persistence, so a fresh process starts with no budgets
 * and no ledger. Re-create them at startup.
 */
export function getBudget(name: string): BudgetHandle | undefined {
  const opts = registry.get(name);
  if (opts === undefined) return undefined;
  return buildHandle(opts);
}

/**
 * Every budget registered in this process, in insertion order.
 *
 * Empty after a restart — see {@link getBudget} on process-local state. Use it to enumerate what is
 * being enforced; use {@link snapshotAll} when you want the numbers rather than the handles.
 */
export function listBudgets(): readonly BudgetHandle[] {
  return [...registry.values()].map(buildHandle);
}

/**
 * Remove a budget from the registry. Returns `false` when the name was not registered.
 *
 * This stops ENFORCEMENT; it does not refund or clear the ledger. Re-creating a budget under the
 * same name inherits the spend already recorded for that name, which is usually what you want after
 * a config reload and a surprise if you were expecting a reset.
 */
export function deleteBudget(name: string): boolean {
  return registry.delete(name);
}

/**
 * One row per budget PER WINDOW — a budget with three limits produces three rows, not one.
 *
 * `ratio` is `spentUsd / limitUsd`, and is 0 when the limit is 0 rather than `Infinity`, so a
 * zero-limit budget does not poison a dashboard that sums or charts these. Spend is computed at call
 * time from the ledger, counting only entries inside each window, so the same budget reports
 * different numbers for `1d` and `30d`.
 */
export function snapshotAll(): readonly BudgetSnapshot[] {
  const result: BudgetSnapshot[] = [];
  for (const opts of registry.values()) {
    for (const lim of opts.limits) {
      const spent = spentIn(opts.name, lim.window);
      result.push({
        name: opts.name,
        window: lim.window,
        spentUsd: spent,
        limitUsd: lim.limitUsd,
        ratio: lim.limitUsd > 0 ? spent / lim.limitUsd : 0,
        heldUsd: 0, // this ledger has no reservations (Budget.reserve lives in @theokit/sdk)
      });
    }
  }
  return result;
}

/**
 * The stored {@link BudgetOptions} exactly as registered, or `undefined` when the name is unknown.
 *
 * Distinct from {@link getBudget}, which returns a HANDLE with live accessors. Use this when you
 * need the configuration itself — the limits array, the callbacks, the declared mode — for example
 * to render it or to re-register the same shape elsewhere.
 *
 * The object is the registry's own, held by reference: mutating it changes what the budget enforces
 * without going through `Budget.create`, which is a bug waiting to happen. Copy before editing.
 */
export function getBudgetOptionsRaw(name: string): BudgetOptions | undefined {
  return registry.get(name);
}

/**
 * The mode a budget enforces, resolving the omitted case to `"warn"`.
 *
 * `"warn"` fires the callbacks and lets the call through; `"block"` refuses it. The default is
 * deliberate: a budget added for observability must not start rejecting traffic because someone
 * forgot a field.
 */
export function defaultMode(opts: BudgetOptions): BudgetMode {
  return opts.mode ?? "warn";
}

function buildHandle(opts: BudgetOptions): BudgetHandle {
  return {
    name: opts.name,
    mode: defaultMode(opts),
    scope: opts.scope,
    limits: opts.limits,
    spentIn: (window: BudgetWindow) => spentIn(opts.name, window),
    remainingIn: (window: BudgetWindow) => {
      const lim = opts.limits.find((l) => l.window === window);
      if (lim === undefined) return Number.POSITIVE_INFINITY;
      return Math.max(0, lim.limitUsd - spentIn(opts.name, window));
    },
  };
}
