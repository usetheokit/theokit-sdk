/**
 * Budget enforcement (ADRs D383, D386, EC-7/8/9).
 *
 * - `preflightCheck(name, estimatedUsd)` — in `block` mode, throw
 *   `BudgetExceededError` before the LLM call if any limit would be
 *   exceeded (EC-9 — the caller invokes it inside the mutex section).
 * - `chargeAndCheckThresholds(name, actualUsd)` — apply the charge to the
 *   ledger + invoke onThreshold/onExceed callbacks isolated in
 *   try/catch (EC-8).
 *
 * @internal
 */

import { BudgetExceededError } from "../../errors.js";
import type { BudgetMode, BudgetOptions, BudgetReservation } from "../../types/budget.js";
import { diag } from "../diagnostics.js";
import { addHold, assertUsdAmount, dropHold, type Hold, heldUsd } from "./holds.js";
import { charge, spentIn } from "./ledger.js";
import { defaultMode, getBudgetOptionsRaw } from "./registry.js";

const THRESHOLDS = [0.8, 0.95] as const;
type Threshold = (typeof THRESHOLDS)[number];

/**
 * Throws BudgetExceededError if `mode === "block"` and any limit
 * would be exceeded. No-op for audit/warn modes (post-charge checks
 * handle those).
 *
 * Caller invokes this BEFORE the LLM call.
 */
export function preflightCheck(name: string, estimatedUsd: number): void {
  const opts = getBudgetOptionsRaw(name);
  if (opts === undefined) return; // EC-20: budget deleted; charge becomes no-op
  if (defaultMode(opts) !== "block") return;
  for (const lim of opts.limits) {
    const currentSpent = spentIn(opts.name, lim.window) + heldUsd(opts.name);
    if (currentSpent + estimatedUsd > lim.limitUsd) {
      throw new BudgetExceededError({
        budgetName: opts.name,
        window: lim.window,
        spentUsd: currentSpent + estimatedUsd,
        limitUsd: lim.limitUsd,
        mode: "block",
      });
    }
  }
}

/**
 * Reserve `estimatedUsd` against a budget. In block mode throws if committed spend + open holds +
 * the estimate would exceed a limit; otherwise records a hold. A deleted budget yields a no-op
 * reservation (EC-20).
 */
export function reserveBudget(name: string, estimatedUsd: number): BudgetReservation {
  assertUsdAmount("estimatedUsd", estimatedUsd);
  const opts = getBudgetOptionsRaw(name);
  if (opts === undefined) return buildReservation(name, estimatedUsd, undefined);
  preflightCheck(name, estimatedUsd);
  return buildReservation(name, estimatedUsd, addHold(name, estimatedUsd));
}

function buildReservation(
  budgetName: string,
  estimatedUsd: number,
  hold: Hold | undefined,
): BudgetReservation {
  return {
    budgetName,
    estimatedUsd,
    settle: (actualUsd) => settleHold(hold, actualUsd),
    release: () => {
      if (hold?.state === "open") dropHold(hold);
    },
  };
}

/**
 * Charge the actual cost while the hold is still counted, drop the hold, then run callbacks, so no
 * preflight can pass through the gap between charge and release.
 */
async function settleHold(hold: Hold | undefined, actualUsd: number): Promise<void> {
  assertUsdAmount("actualUsd", actualUsd);
  if (hold === undefined || hold.state !== "open") return;
  hold.state = "settling";
  const opts = getBudgetOptionsRaw(hold.budgetName);
  try {
    if (opts !== undefined) await charge(opts.name, actualUsd);
  } finally {
    dropHold(hold);
  }
  const mode = opts === undefined ? "audit" : defaultMode(opts);
  if (opts === undefined || mode === "audit") return;
  await dispatchCallbacksFor(opts, mode);
}

/**
 * Charge the budget + dispatch threshold/exceed callbacks (EC-8 isolated).
 *
 * - In `audit` mode: charge only, no callbacks.
 * - In `warn` mode: charge + onThreshold (80/95) + onExceed (100). No throw.
 * - In `block` mode: charge + onThreshold + onExceed. No throw post-call
 *   (preflightCheck already prevented exceed for the upcoming call;
 *   this protects against simultaneous-call races where multiple sends
 *   each pass preflight independently — last one to charge may still
 *   tip a limit. We document the case rather than retroactively throw).
 */
export async function chargeAndCheckThresholds(name: string, actualUsd: number): Promise<void> {
  const opts = getBudgetOptionsRaw(name);
  if (opts === undefined) {
    // EC-20: budget deleted during in-flight call. Charge is silent no-op.
    diag(
      `[budget] charge for deleted budget "${name}" is a no-op (was the budget removed during in-flight send?)\n`,
    );
    return;
  }
  const mode = defaultMode(opts);

  await charge(opts.name, actualUsd);

  if (mode === "audit") return;
  await dispatchCallbacksFor(opts, mode);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 3-mode × 3-threshold dispatch table inherently branchy; pulling out helpers loses local context.
async function dispatchCallbacksFor(opts: BudgetOptions, mode: BudgetMode): Promise<void> {
  for (const lim of opts.limits) {
    const spent = spentIn(opts.name, lim.window);
    if (lim.limitUsd <= 0) {
      if (spent > 0) await dispatchExceed(opts, lim.window, spent, lim.limitUsd, mode);
      continue;
    }
    const ratio = spent / lim.limitUsd;
    if (ratio >= 1) {
      await dispatchExceed(opts, lim.window, spent, lim.limitUsd, mode);
    } else {
      // Iterate descending so the HIGHEST matched threshold fires (0.95 not 0.8)
      for (const t of [...THRESHOLDS].reverse() as Threshold[]) {
        if (ratio >= t) {
          await dispatchThreshold(opts, lim.window, spent, lim.limitUsd, t);
          break;
        }
      }
    }
  }
}

async function dispatchThreshold(
  opts: BudgetOptions,
  window: BudgetOptions["limits"][number]["window"],
  spentUsd: number,
  limitUsd: number,
  threshold: Threshold,
): Promise<void> {
  if (opts.onThreshold === undefined) return;
  try {
    await opts.onThreshold({
      budgetName: opts.name,
      window,
      threshold,
      spentUsd,
      limitUsd,
    });
  } catch (err) {
    // EC-8: callback throw isolated
    const msg = err instanceof Error ? err.message : String(err);
    diag(`[budget] onThreshold callback threw: ${msg}\n`);
  }
}

async function dispatchExceed(
  opts: BudgetOptions,
  window: BudgetOptions["limits"][number]["window"],
  spentUsd: number,
  limitUsd: number,
  mode: BudgetMode,
): Promise<void> {
  if (opts.onExceed === undefined) {
    if (mode === "warn") {
      diag(
        `[budget] "${opts.name}" exceeded ${window} limit: $${spentUsd.toFixed(4)} > $${limitUsd.toFixed(4)}\n`,
      );
    }
    return;
  }
  try {
    await opts.onExceed({
      budgetName: opts.name,
      window,
      spentUsd,
      limitUsd,
      mode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diag(`[budget] onExceed callback threw: ${msg}\n`);
  }
}
