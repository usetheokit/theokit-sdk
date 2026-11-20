/**
 * Tests for suspend/resume: sentinel pattern, snapshot persistence,
 * EC-4 non-serializable, EC-8 step-not-found on resume.
 */

import { describe, expect, it } from "vitest";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";

import {
  fn,
  Workflow,
  WorkflowNotSerializableError,
  WorkflowSnapshotNotFoundError,
} from "../../src/workflow.js";

describe("workflow suspend/resume", () => {
  it("ctx.suspend pauses the run with status: 'suspended'", async () => {
    const wf = Workflow.create({ name: "susp" })
      .then(fn<unknown, string>("phase1", async () => "phase1-done"))
      .then(
        fn<string, string>("wait-for-approval", async (_input, ctx) => {
          await ctx.suspend({ awaiting: "approval" });
          // Unreachable
          return "never";
        }),
      )
      .then(fn<string, string>("phase3", async () => "phase3-done"))
      .commit();

    const run = await wf.run(undefined);
    expect(run.status).toBe("suspended");
    // First step ran; second step is the suspend point.
    expect(run.stepResults.length).toBeGreaterThanOrEqual(1);
    __resetSnapshotStoresForTests();
  });

  it("EC-4 — suspend with BigInt payload throws WorkflowNotSerializableError", async () => {
    const wf = Workflow.create({ name: "susp-bigint" })
      .then(
        fn<unknown, string>("susp", async (_i, ctx) => {
          await ctx.suspend({ big: BigInt(123) });
          return "never";
        }),
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("failed");
    expect(run.error?.name).toBe(WorkflowNotSerializableError.name);
    __resetSnapshotStoresForTests();
  });

  it("EC-4 — suspend with circular ref throws WorkflowNotSerializableError", async () => {
    const wf = Workflow.create({ name: "susp-circ" })
      .then(
        fn<unknown, string>("susp", async (_i, ctx) => {
          const obj: Record<string, unknown> = {};
          obj.self = obj;
          await ctx.suspend(obj);
          return "never";
        }),
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("failed");
    expect(run.error?.name).toBe(WorkflowNotSerializableError.name);
    __resetSnapshotStoresForTests();
  });

  it("Workflow.resume throws WorkflowSnapshotNotFoundError for unknown runId", async () => {
    const wf = Workflow.create({ name: "resume-missing" })
      .then(fn("a", async () => 1))
      .commit();

    await expect(Workflow.resume({ runId: "wfr-deadbeef", workflow: wf })).rejects.toThrow(
      WorkflowSnapshotNotFoundError,
    );
    __resetSnapshotStoresForTests();
  });

  it("resume continues from snapshot (in-memory store)", async () => {
    const wf = Workflow.create({ name: "resume-ok" })
      .then(fn("phase1", async () => "phase1-done"))
      .then(
        fn<unknown, string>("susp", async (_i, ctx) => {
          await ctx.suspend({ awaiting: "approval" });
          return "never";
        }),
      )
      .then(fn<unknown, string>("phase3", async (input) => `phase3 saw: ${JSON.stringify(input)}`))
      .commit();

    const first = await wf.run(undefined);
    expect(first.status).toBe("suspended");
    const runId = first.id;

    const resumed = await Workflow.resume<string>({
      runId,
      workflow: wf,
      payload: { approved: true },
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.output).toContain("approved");
    __resetSnapshotStoresForTests();
  });
});
