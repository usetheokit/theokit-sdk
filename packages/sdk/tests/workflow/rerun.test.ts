import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";
import {
  fn,
  Workflow,
  WorkflowResumeStepNotFoundError,
  WorkflowSnapshotNotFoundError,
} from "../../src/workflow.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

afterEach(() => __resetSnapshotStoresForTests());

function build(
  persistence: object,
  counts: Record<string, number>,
  inputs: Record<string, unknown>,
) {
  const step = (id: string, f: (n: number, state: { count: number }) => number) =>
    fn<number, number>(id, async (n, ctx) => {
      counts[id] = (counts[id] ?? 0) + 1;
      inputs[id] = n;
      inputs[`${id}:count`] = ((ctx.state as { count: number } | undefined)?.count ?? 0) + 1;
      const state = { ...((ctx.state as { count: number } | undefined) ?? { count: 0 }) };
      state.count += 1;
      ctx.setState(state);
      return f(n, state);
    });
  return Workflow.create({
    name: "rerun",
    // biome-ignore lint/suspicious/noExplicitAny: test persistence variants
    persistence: persistence as any,
  })
    .then(step("s1", (n) => n + 1))
    .then(step("s2", (n) => n * 10))
    .then(step("s3", (n, s) => n + s.count * 1000))
    .then(step("s4", (n) => n + 1))
    .commit();
}

async function backends(): Promise<Array<[string, object]>> {
  const dir = await mkdtemp(join(tmpdir(), "wf-rerun-"));
  onTestFinished(() => removeTempDirRobust(dir));
  return [
    ["memory", { backend: "memory", durability: "step", keepHistory: true }],
    ["json", { backend: "json", dir, durability: "step", keepHistory: true }],
  ];
}

describe("workflow rerunFrom", () => {
  it("rerun_from_a_step_skips_the_steps_before_it", async () => {
    for (const [, p] of await backends()) {
      const counts: Record<string, number> = {};
      const inputs: Record<string, unknown> = {};
      const wf = build(p, counts, inputs);
      const first = await wf.run(1, { runId: "orig-run" });
      expect(first.status).toBe("completed");
      const hist = await wf.history(first.id);
      expect(hist.map((h) => h.stepId)).toEqual(["s1", "s2", "s3", "s4"]);
      const again = await wf.rerunFrom({ runId: first.id, stepId: "s3" });
      expect(again.status).toBe("completed");
      expect(counts).toEqual({ s1: 1, s2: 1, s3: 2, s4: 2 });
      expect(inputs.s3).toBe(20);
      expect(again.id).not.toBe(first.id);
      expect(again.rerunOf).toEqual({ runId: first.id, stepId: "s3" });
      expect((await wf.history(again.id)).map((h) => h.stepId)).toEqual(["s1", "s2", "s3", "s4"]);
    }
  });

  it("rerun_restores_the_state_of_that_point", async () => {
    for (const [, p] of await backends()) {
      const inputs: Record<string, unknown> = {};
      const wf = build(p, {}, inputs);
      const first = await wf.run(1);
      // count after s2 is 2, so s3 sees 3 → 20 + 3000
      expect(first.output).toBe(20 + 3000 + 1);
      expect(inputs["s3:count"]).toBe(3);
      inputs["s3:count"] = undefined;
      const again = await wf.rerunFrom({ runId: first.id, stepId: "s3" });
      expect(inputs["s3:count"]).toBe(3);
      // s3 sees count 3 (2 after s2, +1 in s3) — not 5 as a replayed final state would give
      expect(again.output).toBe(20 + 3000 + 1);
    }
  });

  it("history_of_a_json_suffixed_run_id_is_not_listed_as_a_snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-rerun-"));
    onTestFinished(() => removeTempDirRobust(dir));
    const wf = Workflow.create({
      name: "rerun-json-suffix",
      persistence: { backend: "json", dir, durability: "step", keepHistory: true },
    })
      .then(fn<number, number>("a", async (n) => n + 1))
      .then(fn<number, number>("b", async (n) => n + 1))
      .commit();
    const run = await wf.run(1, { runId: "x.json" });
    expect((await wf.history(run.id)).map((h) => h.stepId)).toEqual(["a", "b"]);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["history"]);
  });

  it("history_survives_path_like_step_and_run_ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-rerun-"));
    onTestFinished(() => removeTempDirRobust(dir));
    const wf = Workflow.create({
      name: "rerun-paths",
      persistence: { backend: "json", dir, durability: "step", keepHistory: true },
    })
      .then(fn<number, number>("a-b", async (n) => n + 1))
      .then(fn<number, number>("c", async (n) => n + 1))
      .commit();
    const run = await wf.run(1, { runId: "r/../x" });
    expect((await wf.history(run.id)).map((h) => h.stepId)).toEqual(["a-b", "c"]);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["history"]);
    expect(await readdir(join(dir, "history"))).toEqual(["r%2F..%2Fx"]);
  });

  it("rerun_leaves_the_original_history_intact", async () => {
    for (const [, p] of await backends()) {
      const wf = build(p, {}, {});
      const first = await wf.run(1);
      const before = await wf.history(first.id);
      const again = await wf.rerunFrom({ runId: first.id, stepId: "s2", input: 5 });
      expect(again.output).toBe(50 + 3000 + 1);
      expect(await wf.history(first.id)).toEqual(before);
      expect(again.id).not.toBe(first.id);
    }
  });

  it("rerun_from_the_first_step_uses_the_original_input", async () => {
    for (const [, p] of await backends()) {
      const inputs: Record<string, unknown> = {};
      const wf = build(p, {}, inputs);
      const first = await wf.run(1);
      const again = await wf.rerunFrom({ runId: first.id, stepId: "s1" });
      expect(inputs.s1).toBe(1);
      expect(again.output).toBe(first.output);
    }
  });

  it("rerun_with_unknown_step_is_refused", async () => {
    const p = (await backends())[0]?.[1] as object;
    const wf = build(p, {}, {});
    const first = await wf.run(1);
    await expect(wf.rerunFrom({ runId: first.id, stepId: "nope" })).rejects.toBeInstanceOf(
      WorkflowResumeStepNotFoundError,
    );
    await expect(wf.rerunFrom({ runId: "missing", stepId: "s2" })).rejects.toBeInstanceOf(
      WorkflowSnapshotNotFoundError,
    );
  });

  it("keep_history_requires_step_durability", () => {
    expect(() =>
      Workflow.create({ name: "x", persistence: { backend: "memory", keepHistory: true } }),
    ).toThrow(/keepHistory.*durability/);
  });
});
