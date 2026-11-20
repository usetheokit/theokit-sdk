/**
 * In-flight holds against a budget (`Budget.reserve`). A hold is an estimate that has not been
 * charged yet; `preflightCheck` adds the open holds to committed spend so concurrent calls see
 * each other's estimates.
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";

export type HoldState = "open" | "settling" | "closed";

export interface Hold {
  readonly budgetName: string;
  readonly usd: number;
  state: HoldState;
}

const holds = new Map<string, Set<Hold>>();

/** Throws `ConfigurationError` unless `value` is a finite, non-negative number. */
export function assertUsdAmount(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigurationError(`${label} must be a finite number >= 0 (got ${String(value)})`, {
      code: "invalid_budget_amount",
    });
  }
}

/** Record an open hold. */
export function addHold(budgetName: string, usd: number): Hold {
  const hold: Hold = { budgetName, usd, state: "open" };
  const set = holds.get(budgetName) ?? new Set<Hold>();
  set.add(hold);
  holds.set(budgetName, set);
  return hold;
}

/** Drop a hold from the total. Safe to call twice. */
export function dropHold(hold: Hold): void {
  hold.state = "closed";
  const set = holds.get(hold.budgetName);
  if (set === undefined) return;
  set.delete(hold);
  if (set.size === 0) holds.delete(hold.budgetName);
}

/** Total USD of open holds for a budget. */
export function heldUsd(budgetName: string): number {
  let total = 0;
  for (const hold of holds.get(budgetName) ?? []) total += hold.usd;
  return total;
}

/** Invalidate every hold of a budget (budget deleted). Later settle/release become no-ops. */
export function clearHolds(budgetName: string): void {
  for (const hold of holds.get(budgetName) ?? []) hold.state = "closed";
  holds.delete(budgetName);
}

export function __resetHoldsForTests(): void {
  for (const set of holds.values()) for (const hold of set) hold.state = "closed";
  holds.clear();
}
