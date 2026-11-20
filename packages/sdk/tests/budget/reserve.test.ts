/**
 * Budget.reserve — in-flight holds count against a block budget (#1087).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Budget } from "../../src/budget.js";
import { BudgetExceededError, ConfigurationError } from "../../src/errors.js";
import { preflightCheck } from "../../src/internal/budget/enforcement.js";
import { __resetLedgerForTests } from "../../src/internal/budget/ledger.js";
import { __resetRegistryForTests } from "../../src/internal/budget/registry.js";
import type { BudgetThresholdEvent } from "../../src/types/budget.js";

function snap(name: string) {
  const s = Budget.snapshot().find((x) => x.name === name);
  if (s === undefined) throw new Error("no snapshot");
  return s;
}

describe("Budget.reserve", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __resetLedgerForTests();
  });
  afterEach(() => {
    __resetRegistryForTests();
    __resetLedgerForTests();
  });

  const block = () =>
    Budget.create({
      name: "b",
      scope: "process",
      mode: "block",
      limits: [{ window: "1d", limitUsd: 1 }],
    });

  it("second reserve throws while the first is open", () => {
    block();
    Budget.reserve("b", 0.6);
    expect(() => Budget.reserve("b", 0.6)).toThrow(BudgetExceededError);
  });

  it("release frees the hold", () => {
    block();
    const r = Budget.reserve("b", 0.6);
    r.release();
    r.release();
    expect(() => Budget.reserve("b", 0.6)).not.toThrow();
  });

  it("settle charges actual and drops the hold", async () => {
    block();
    const r = Budget.reserve("b", 0.6);
    expect(snap("b").heldUsd).toBeCloseTo(0.6);
    await r.settle(0.3);
    expect(snap("b").spentUsd).toBeCloseTo(0.3);
    expect(snap("b").heldUsd).toBe(0);
  });

  it("settle twice charges once; settle after release is a no-op", async () => {
    block();
    const r = Budget.reserve("b", 0.2);
    await Promise.all([r.settle(0.2), r.settle(0.2)]);
    await r.settle(0.2);
    expect(snap("b").spentUsd).toBeCloseTo(0.2);
    const r2 = Budget.reserve("b", 0.2);
    r2.release();
    await r2.settle(0.2);
    expect(snap("b").spentUsd).toBeCloseTo(0.2);
  });

  it("fires the 80% callback once on settle", async () => {
    const events: BudgetThresholdEvent[] = [];
    Budget.create({
      name: "t",
      scope: "process",
      limits: [{ window: "1d", limitUsd: 1 }],
      onThreshold: (e) => {
        events.push(e);
      },
    });
    const r = Budget.reserve("t", 0.5);
    await r.settle(0.85);
    expect(events.map((e) => e.threshold)).toEqual([0.8]);
  });

  it("plain preflightCheck counts open holds", () => {
    block();
    Budget.reserve("b", 0.6);
    expect(() => preflightCheck("b", 0.5)).toThrow(BudgetExceededError);
  });

  it("rejects invalid amounts and keeps the hold open", async () => {
    block();
    expect(() => Budget.reserve("b", -1)).toThrow(ConfigurationError);
    const r = Budget.reserve("b", 0.1);
    await expect(r.settle(Number.NaN)).rejects.toThrow(ConfigurationError);
    expect(snap("b").heldUsd).toBeCloseTo(0.1);
    await r.settle(0.1);
    expect(snap("b").spentUsd).toBeCloseTo(0.1);
  });

  it("warn mode records the hold and never throws", () => {
    Budget.create({ name: "w", scope: "process", limits: [{ window: "1d", limitUsd: 1 }] });
    Budget.reserve("w", 0.9);
    expect(() => Budget.reserve("w", 0.9)).not.toThrow();
    expect(snap("w").heldUsd).toBeCloseTo(1.8);
  });

  it("deleted budget: no-op reservation, and old holds do not leak to a recreation", async () => {
    expect(() => Budget.reserve("gone", 5)).not.toThrow();
    block();
    const r = Budget.reserve("b", 0.6);
    Budget.delete("b");
    block();
    expect(snap("b").heldUsd).toBe(0);
    await r.settle(0.6);
    expect(snap("b").spentUsd).toBe(0);
  });
});
