import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { __resetSnapshotStoresForTests, fn, Workflow } from "../../src/workflow.js";
import {
  WorkflowResumeStepNotFoundError,
  WorkflowSnapshotNotFoundError,
} from "../../src/workflow-errors.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

afterEach(() => __resetSnapshotStoresForTests());

function build(persistence: object, calls: Record<string, number>, seen: unknown[] = []) {
  const bump = (id: string) => {
    calls[id] = (calls[id] ?? 0) + 1;
  };
  const wf = Workflow.create({
    name: "rerun",
    initialState: { count: 0 },
    persistence: { durability: "step", keepHistory: true, ...persistence },
  } as never)
    .then(
      fn<number, number>("s1", (n, ctx) => {
        bump("s1");
        ctx.setState({ count: (ctx.state as { count: number }).count + 1 });
        return n + 1;
      }),
    )
    .then(
      fn<number, number>("s2", (n, ctx) => {
        bump("s2");
        ctx.setState({ count: (ctx.state as { count: number }).count + 1 });
        return n * 10;
      }),
    )
    .then(
      fn<number, number>("s3", (n, ctx) => {
        bump("s3");
        seen.push({ input: n, state: ctx.state });
        ctx.setState({ count: (ctx.state as { count: number }).count + 1 });
        return n + 1;
      }),
    )
    .then(fn<number, number>("s4", (n) => (bump("s4"), n + 1)))
    .commit();
  return wf as unknown as Workflow<number, number>;
}

async function backends() {
  const dir = await mkdtemp(join(tmpdir(), "wf-rerun-"));
  onTestFinished(() => removeTempDirRobust(dir));
  return [{ backend: "memory" }, { backend: "json", dir }];
}

describe("workflow rerunFrom", () => {
  it("rerun_from_a_step_skips_the_steps_before_it", async () => {
    for (const p of await backends()) {
      __resetSnapshotStoresForTests();
      const calls: Record<string, number> = {};
      const seen: unknown[] = [];
      const wf = build(p, calls, seen);
      const run = await wf.run(1, { runId: "orig" });
      expect(run.output).toBe(22);
      const re = await wf.rerunFrom({ runId: "orig", stepId: "s3" });
      expect(re.status).toBe("completed");
      expect(re.output).toBe(22);
      expect(re.stepResults.map((s) => s.stepId)).toEqual(["s3", "s4"]);
      expect(calls).toEqual({ s1: 1, s2: 1, s3: 2, s4: 2 });
      expect((seen[1] as { input: number }).input).toBe(20);
      const over = await wf.rerunFrom({ runId: "orig", stepId: "s3", input: 5 });
      expect(over.output).toBe(7);
    }
  });

  it("rerun_from_the_first_step_uses_the_original_input", async () => {
    const calls: Record<string, number> = {};
    const wf = build({ backend: "memory" }, calls);
    await wf.run(1, { runId: "o1" });
    const re = await wf.rerunFrom({ runId: "o1", stepId: "s1" });
    expect(re.output).toBe(22);
    expect(calls.s1).toBe(2);
  });

  it("rerun_restores_the_state_of_that_point", async () => {
    for (const p of await backends()) {
      __resetSnapshotStoresForTests();
      const seen: unknown[] = [];
      const wf = build(p, {}, seen);
      await wf.run(1, { runId: "orig" });
      await wf.rerunFrom({ runId: "orig", stepId: "s3" });
      expect(seen[0]).toEqual({ input: 20, state: { count: 2 } });
      expect(seen[1]).toEqual({ input: 20, state: { count: 2 } });
    }
  });

  it("rerun_leaves_the_original_history_intact", async () => {
    for (const p of await backends()) {
      __resetSnapshotStoresForTests();
      const wf = build(p, {});
      await wf.run(1, { runId: "orig" });
      const before = await wf.history("orig");
      expect(before.map((c) => c.stepId)).toEqual(["s1", "s2", "s3", "s4"]);
      const re = await wf.rerunFrom({ runId: "orig", stepId: "s2" });
      expect(await wf.history("orig")).toEqual(before);
      expect(re.id).not.toBe("orig");
      expect(re.rerunOf).toEqual({ runId: "orig", stepId: "s2" });
    }
  });

  it("rerun_with_unknown_step_is_refused", async () => {
    const wf = build({ backend: "memory" }, {});
    await wf.run(1, { runId: "orig" });
    await expect(wf.rerunFrom({ runId: "orig", stepId: "nope" })).rejects.toBeInstanceOf(
      WorkflowResumeStepNotFoundError,
    );
  });

  it("rerun_with_unknown_run_is_refused", async () => {
    const wf = build({ backend: "memory" }, {});
    await expect(wf.rerunFrom({ runId: "ghost", stepId: "s2" })).rejects.toBeInstanceOf(
      WorkflowSnapshotNotFoundError,
    );
  });

  it("rerun_can_replay_a_failed_run", async () => {
    let fail = true;
    const wf = Workflow.create({
      name: "rerun-fail",
      persistence: { backend: "memory", durability: "step", keepHistory: true },
    })
      .then(fn<number, number>("a", (n) => n + 1))
      .then(
        fn<number, number>("b", (n) => {
          if (fail) throw new Error("bad prompt");
          return n * 2;
        }),
      )
      .commit();
    const bad = await wf.run(1, { runId: "f1" });
    expect(bad.status).toBe("failed");
    fail = false;
    const re = await wf.rerunFrom({ runId: "f1", stepId: "b" });
    expect(re.output).toBe(4);
  });

  it("keep_history_requires_step_durability", () => {
    const make = (persistence: object) => () =>
      Workflow.create({ name: "x", persistence } as never);
    expect(make({ backend: "memory", keepHistory: true })).toThrow(ConfigurationError);
    expect(make({ backend: "memory", keepHistory: true })).toThrow(/keepHistory.*durability/);
    expect(make({ backend: "memory", durability: "suspend", keepHistory: true })).toThrow(
      ConfigurationError,
    );
    expect(make({ backend: "memory", durability: "step", keepHistory: true })).not.toThrow();
  });
});
