import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSnapshotStoresForTests, fn, Workflow } from "../../src/workflow.js";

afterEach(() => __resetSnapshotStoresForTests());

type Mode = "ok" | "fail" | "crash";

function build(
  dir: string | undefined,
  durability: "step" | undefined,
  mode: Mode,
  calls: number[],
) {
  return Workflow.create({
    name: "dur",
    persistence: dir
      ? { backend: "json", dir, ...(durability ? { durability } : {}) }
      : { backend: "memory", ...(durability ? { durability } : {}) },
  })
    .then(
      fn<number, number>("s1", async (n, ctx) => {
        calls[0] = (calls[0] ?? 0) + 1;
        ctx.setState({ seen: "s1" });
        return n + 1;
      }),
    )
    .then(
      fn<number, number>("s2", async (n) => {
        calls[1] = (calls[1] ?? 0) + 1;
        return n * 10;
      }),
    )
    .then(
      fn<number, string>("s3", async (n, ctx) => {
        calls[2] = (calls[2] ?? 0) + 1;
        if (mode === "fail") throw new Error("boom");
        if (mode === "crash") return new Promise<string>(() => {});
        return `${n}:${JSON.stringify(ctx.state)}`;
      }),
    )
    .commit();
}

describe("workflow step durability", () => {
  it("step_durability_resumes_after_a_crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-dur-"));
    const calls: number[] = [];
    const crashing = build(dir, "step", "crash", calls);
    const ac = new AbortController();
    void crashing.run(1, { runId: "r1", signal: ac.signal });
    // Step 3 has started once its call counter is set; step 2's checkpoint is written before that.
    while (calls[2] === undefined) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const fresh = build(dir, "step", "ok", calls);
    const run = await Workflow.resume<string>({ workflow: fresh, runId: "r1" });
    expect(run.status).toBe("completed");
    expect(run.output).toBe('20:{"seen":"s1"}');
    expect(calls[0]).toBe(1);
    expect(calls[1]).toBe(1);
    expect(calls[2]).toBe(2);
    expect(run.stepResults.map((r) => r.stepId)).toEqual(["s1", "s2", "s3"]);
    expect(await fresh.listRuns()).toEqual([]);
  });

  it("step_durability_keeps_the_last_checkpoint_on_failure", async () => {
    const wf = build(undefined, "step", "fail", []);
    const run = await wf.run(1, { runId: "r2" });
    expect(run.status).toBe("failed");
    const runs = await wf.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "r2", status: "running", currentStepId: "s2" });
  });

  it("completed_run_leaves_no_checkpoint", async () => {
    const wf = build(undefined, "step", "ok", []);
    expect((await wf.run(1)).status).toBe("completed");
    expect(await wf.listRuns()).toEqual([]);
  });

  it("default_durability_writes_nothing_until_suspend", async () => {
    const wf = build(undefined, undefined, "fail", []);
    await wf.run(1);
    expect(await wf.listRuns()).toEqual([]);
  });

  it("resume_of_a_live_run_throws_and_keeps_the_checkpoint", async () => {
    const calls: number[] = [];
    const wf = build(undefined, "step", "crash", calls);
    const ac = new AbortController();
    void wf.run(1, { runId: "r3", signal: ac.signal });
    while (calls[2] === undefined) await new Promise((r) => setTimeout(r, 5));
    await expect(Workflow.resume({ workflow: wf, runId: "r3" })).rejects.toThrow(/already/i);
    expect(await wf.listRuns()).toHaveLength(1);
    ac.abort();
  });

  it("v2_suspend_snapshot_still_resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-v2-"));
    await writeFile(
      join(dir, "old.json"),
      JSON.stringify({
        _schemaVersion: 2,
        runId: "old",
        workflowName: "dur",
        currentStepId: "s1",
        stepResults: [],
        accumulatedInput: 4,
        suspendedAt: 1,
      }),
    );
    const calls: number[] = [];
    const wf = build(dir, undefined, "ok", calls);
    expect((await wf.listRuns())[0]).toMatchObject({ status: "suspended", currentStepId: "s1" });
    const run = await Workflow.resume<string>({ workflow: wf, runId: "old" });
    expect(run.status).toBe("completed");
    expect(calls).toEqual([undefined, 1, 1]);
  });

  it("rejects an invalid durability", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: invalid on purpose
      Workflow.create({
        name: "x",
        persistence: { backend: "memory", durability: "async" as any },
      }),
    ).toThrow();
  });
});
