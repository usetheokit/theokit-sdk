/**
 * M3 #62 (T4.3) — RED-first: a resumed workflow must restore the prior step
 * outputs, not start with an empty stepResults. Before the fix, resume continued
 * from the suspend point with only the payload — mid-flow state (earlier step
 * outputs) was lost.
 */

import { describe, expect, it } from "vitest";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";
import { fn, Workflow } from "../../src/workflow.js";

describe("M3 #62 — workflow resume restores accumulated outputs", () => {
  it("the resumed run's stepResults include the pre-suspend step output", async () => {
    const wf = Workflow.create({ name: "resume-lossy" })
      .then(fn<unknown, string>("step1", async () => "s1-output"))
      .then(
        fn<string, string>("step2-suspend", async (_input, ctx) => {
          await ctx.suspend({ awaiting: "go" });
          return "never";
        }),
      )
      .then(fn<string, string>("step3", async () => "s3-output"))
      .commit();

    const run = await wf.run(undefined);
    expect(run.status).toBe("suspended");

    const resumed = await Workflow.resume<string>({
      runId: run.id,
      workflow: wf,
      payload: { go: true },
    });
    expect(resumed.status).toBe("completed");
    // The pre-suspend step1 output is present in the resumed run — not lost.
    const step1 = resumed.stepResults.find((r) => r.stepId === "step1");
    expect(step1?.output).toBe("s1-output");
    // And step3 (post-resume) is there too.
    expect(resumed.stepResults.some((r) => r.stepId === "step3")).toBe(true);
    __resetSnapshotStoresForTests();
  });
});
