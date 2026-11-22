import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";
import { fn, Workflow } from "../../src/workflow.js";
import {
  WorkflowResumeStepNotFoundError,
  WorkflowSnapshotNotFoundError,
} from "../../src/workflow-errors.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

afterEach(() => __resetSnapshotStoresForTests());

function build(persistence: object, calls: number[], inputs: unknown[]) {
  const step = (i: number) =>
    fn<number, number>(`s${i + 1}`, async (n, ctx) => {
      calls[i] = (calls[i] ?? 0) + 1;
      inputs[i] = n;
      const count = (ctx.state as { count: number }).count + 1;
      ctx.setState({ count });
      return n + 1;
    });
  return Workflow.create({
    name: "rerun",
    initialState: { count: 0 },
    persistence: { ...persistence, durability: "step", keepHistory: true },
  } as never)
    .then(step(0))
    .then(step(1))
    .then(step(2))
    .then(step(3))
    .commit();
}

async function backends(): Promise<Array<[string, object]>> {
  const dir = await mkdtemp(join(tmpdir(), "wf-rerun-"));
  onTestFinished(() => removeTempDirRobust(dir));
  return [
    ["memory", { backend: "memory" }],
    ["json", { backend: "json", dir }],
  ];
}

describe("workflow rerunFrom", () => {
  it("rerun_from_a_step_skips_the_steps_before_it", async () => {
    for (const [, p] of await backends()) {
      const calls: number[] = [];
      const inputs: unknown[] = [];
      const wf = build(p, calls, inputs);
      const run = await wf.run(1, { runId: "r1" });
      expect(run.status).toBe("completed");
      const again = await wf.rerunFrom({ runId: "r1", stepId: "s3" });
      expect(again.status).toBe("completed");
      expect(again.stepResults.map((r) => r.stepId)).toEqual(["s3", "s4"]);
      expect(calls).toEqual([1, 1, 2, 2]);
      expect(inputs[2]).toBe(3); // s2's output
      const override = await wf.rerunFrom({ runId: "r1", stepId: "s3", input: 100 });
      expect(override.output).toBe(102);
      const first = await wf.rerunFrom({ runId: "r1", stepId: "s1" });
      expect(first.output).toBe(5);
    }
  });

  it("rerun_restores_the_state_of_that_point", async () => {
    const [mem] = await backends();
    const calls: number[] = [];
    const wf = build(mem?.[1] as object, calls, []);
    await wf.run(1, { runId: "r1" });
    const again = await wf.rerunFrom({ runId: "r1", stepId: "s3" });
    // after s2 the count was 2; s3 and s4 add two more
    const hist = await wf.history(again.id);
    expect(hist.at(-1)?.state).toEqual({ count: 4 });
    expect(hist[0]?.state).toEqual({ count: 3 });
  });

  it("rerun_leaves_the_original_history_intact", async () => {
    for (const [, p] of await backends()) {
      const wf = build(p, [], []);
      await wf.run(1, { runId: "r1" });
      const before = await wf.history("r1");
      expect(before.map((c) => c.stepId)).toEqual(["s1", "s2", "s3", "s4"]);
      const again = await wf.rerunFrom({ runId: "r1", stepId: "s2" });
      expect(await wf.history("r1")).toEqual(before);
      expect(again.id).not.toBe("r1");
      expect(again.rerunOf).toEqual({ runId: "r1", stepId: "s2" });
      expect((await wf.history(again.id)).map((c) => c.stepId)).toEqual(["s2", "s3", "s4"]);
    }
  });

  it("rerun_with_unknown_step_is_refused", async () => {
    const [mem] = await backends();
    const wf = build(mem?.[1] as object, [], []);
    await wf.run(1, { runId: "r1" });
    await expect(wf.rerunFrom({ runId: "r1", stepId: "nope" })).rejects.toBeInstanceOf(
      WorkflowResumeStepNotFoundError,
    );
    await expect(wf.rerunFrom({ runId: "missing", stepId: "s2" })).rejects.toBeInstanceOf(
      WorkflowSnapshotNotFoundError,
    );
  });

  it("keep_history_requires_step_durability", () => {
    const create = () =>
      Workflow.create({ name: "x", persistence: { backend: "memory", keepHistory: true } });
    expect(create).toThrow(ConfigurationError);
    expect(create).toThrow(/keepHistory.*durability/);
  });
});
