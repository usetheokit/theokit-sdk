/**
 * Internal Budget registry — keeps live `BudgetOptions` per name.
 * Singleton; no persistence (D385).
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
import type {
  BudgetHandle,
  BudgetMode,
  BudgetOptions,
  BudgetSnapshot,
  BudgetWindow,
} from "../../types/budget.js";
import { __resetHoldsForTests, clearHolds, heldUsd } from "./holds.js";
import { spentIn } from "./ledger.js";

const NAME_GRAMMAR = /^[a-z0-9][a-z0-9_-]*$/;

const registry = new Map<string, BudgetOptions>();

export function __resetRegistryForTests(): void {
  registry.clear();
  __resetHoldsForTests();
}

export function validateBudgetName(name: string): void {
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
 * Refuse a `BudgetScope` this version does not implement.
 *
 * `BudgetScope` declares `"agent" | "call" | "process"` and `scope` is REQUIRED, so every caller must
 * pick from a union two-thirds of which is unbuilt. Measured 2026-09-02: nothing outside this file
 * reads `scope` at all — `buildHandle` copies it onto the handle and the tracker never consults it —
 * so `scope: "agent"` was ACCEPTED and silently ignored. A caller asking for per-agent accounting got
 * process-wide accounting and no signal of any kind.
 *
 * That is the failure `rules/error-handling.md` § 2 exists to prevent, and it is worse than the
 * unbuilt feature: a limit believed to be per-agent, applied globally, is a cost control that reports
 * the wrong number. Refusing is honest; narrowing the union to `"process"` would be honest too and is
 * a breaking change to a published type, so it belongs to a major rather than to this fix.
 *
 * @internal
 */
function assertImplementedScope(scope: BudgetOptions["scope"]): void {
  if (scope === "process") return;
  throw new ConfigurationError(
    `Budget scope "${scope}" is declared but not implemented — only "process" is honoured. ` +
      "A budget created with it would have been accounted process-wide with no warning.",
    { code: "unimplemented_budget_scope" },
  );
}

export function createBudget(opts: BudgetOptions): BudgetHandle {
  // EC-7: name validation
  validateBudgetName(opts.name);
  assertImplementedScope(opts.scope);
  if (registry.has(opts.name)) {
    // EC-16: duplicate throws (vs Task.submit idempotent return)
    throw new ConfigurationError(`Budget "${opts.name}" already exists`, {
      code: "invalid_budget_name",
    });
  }
  registry.set(opts.name, opts);
  return buildHandle(opts);
}

export function getBudget(name: string): BudgetHandle | undefined {
  const opts = registry.get(name);
  if (opts === undefined) return undefined;
  return buildHandle(opts);
}

export function listBudgets(): readonly BudgetHandle[] {
  return [...registry.values()].map(buildHandle);
}

export function deleteBudget(name: string): boolean {
  clearHolds(name);
  return registry.delete(name);
}

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
        heldUsd: heldUsd(opts.name),
      });
    }
  }
  return result;
}

export function getBudgetOptionsRaw(name: string): BudgetOptions | undefined {
  return registry.get(name);
}

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
