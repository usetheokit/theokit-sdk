/**
 * Tests for the workflow executor: sequential chain, output propagation,
 * abort signal handling (EC-1), failure propagation.
 */

import { describe, expect, it } from "vitest";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";

import { fn, Workflow } from "../../src/workflow.js";

describe("workflow executor — sequential", () => {
  it("runs steps in order and propagates output -> input", async () => {
    const wf = Workflow.create({ name: "seq" })
      .then(fn("a", async () => ({ value: 1 })))
      .then(
        fn<{ value: number }, { value: number }>("b", async (input) => ({
          value: input.value + 10,
        })),
      )
      .then(
        fn<{ value: number }, { value: number }>("c", async (input) => ({
          value: input.value * 2,
        })),
      )
      .commit();

    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ value: 22 });
    expect(run.stepResults).toHaveLength(3);
    expect(run.stepResults[0]?.stepId).toBe("a");
    expect(run.stepResults[2]?.stepId).toBe("c");
  });

  it("returns failed status when a step throws", async () => {
    const wf = Workflow.create({ name: "fail" })
      .then(fn("a", async () => "ok"))
      .then(
        fn("b", async () => {
          throw new Error("kaboom");
        }),
      )
      .then(fn("c", async () => "never"))
      .commit();

    const run = await wf.run(undefined);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toMatch(/kaboom/);
    expect(run.stepResults).toHaveLength(2); // c never ran
    expect(run.stepResults[1]?.status).toBe("failed");
  });

  it("EC-1 — throws AbortError when signal already aborted at entry", async () => {
    const wf = Workflow.create({ name: "abort-entry" })
      .then(fn("a", async () => "should not run"))
      .commit();
    const ctrl = new AbortController();
    ctrl.abort("user cancelled");
    const run = await wf.run(undefined, { signal: ctrl.signal });
    expect(run.status).toBe("cancelled");
    expect(run.stepResults).toHaveLength(0); // executor never dispatched first step
    __resetSnapshotStoresForTests();
  });

  it("respects signal aborted mid-run between steps", async () => {
    const ctrl = new AbortController();
    let firstStepRan = false;
    const wf = Workflow.create({ name: "abort-mid" })
      .then(
        fn("a", async () => {
          firstStepRan = true;
          ctrl.abort();
          return "1";
        }),
      )
      .then(fn("b", async () => "should not run"))
      .commit();
    const run = await wf.run(undefined, { signal: ctrl.signal });
    expect(firstStepRan).toBe(true);
    expect(run.status).toBe("cancelled");
    expect(run.stepResults).toHaveLength(1); // only first step ran
  });

  it("StepResult.attempts is 1 for default (no retry)", async () => {
    const wf = Workflow.create({ name: "attempts" })
      .then(fn("a", async () => "ok"))
      .commit();
    const run = await wf.run(undefined);
    expect(run.stepResults[0]?.attempts).toBe(1);
  });

  it("StepContext.signal is the live signal", async () => {
    const wf = Workflow.create({ name: "ctx" })
      .then(
        fn("a", async (_input, ctx) => {
          expect(ctx.signal).toBeInstanceOf(AbortSignal);
          expect(ctx.runId).toMatch(/^wfr-/);
          return ctx.runId;
        }),
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(String(run.output)).toMatch(/^wfr-/);
  });
});
