import { describe, expect, it } from "vitest";
import { makeStepContext } from "../../src/internal/workflow/ctx.js";
import { runFnStep } from "../../src/internal/workflow/step-fn.js";
import type { WorkflowEvent } from "../../src/types/workflow.js";
import { fn, Workflow } from "../../src/workflow.js";

type Call = { id: string; input: unknown; output: unknown; message: string };

function build(opts: { failB?: boolean } = {}) {
  const calls: Call[] = [];
  const comp = (id: string) => (input: unknown, output: unknown, error: Error) => {
    calls.push({ id, input, output, message: error.message });
    if (id === "b" && opts.failB) throw new Error("undo b broke");
  };
  const wf = Workflow.create({ name: "saga" })
    .then(fn("a", (n: number) => n + 1, { compensate: comp("a") }))
    .then(fn("b", (n: number) => n * 10, { compensate: comp("b") }))
    .then(
      fn(
        "c",
        () => {
          throw new Error("c boom");
        },
        { compensate: comp("c") },
      ),
    )
    .commit();
  return { wf, calls };
}

describe("workflow compensation", () => {
  it("failed_step_compensates_earlier_steps_in_reverse", async () => {
    const { wf, calls } = build();
    const run = await wf.run(1);
    expect(run.status).toBe("failed");
    expect(calls).toEqual([
      { id: "b", input: 2, output: 20, message: "c boom" },
      { id: "a", input: 1, output: 2, message: "c boom" },
    ]);
    expect(run.compensation).toEqual([
      { stepId: "b", status: "compensated" },
      { stepId: "a", status: "compensated" },
    ]);
  });

  it("failing_compensation_does_not_stop_the_pass", async () => {
    const { wf, calls } = build({ failB: true });
    const run = await wf.run(1);
    expect(calls.map((c) => c.id)).toEqual(["b", "a"]);
    expect(run.compensation?.[0]).toMatchObject({
      stepId: "b",
      status: "failed",
      error: { message: "undo b broke" },
    });
    expect(run.compensation?.[1]).toEqual({ stepId: "a", status: "compensated" });
    expect(run.error?.message).toBe("c boom");
    expect(run.status).toBe("failed");
  });

  it("successful_run_never_compensates", async () => {
    let called = 0;
    const wf = Workflow.create({ name: "ok" })
      .then(fn("a", () => 1, { compensate: () => void called++ }))
      .commit();
    const run = await wf.run(0);
    expect(run.status).toBe("completed");
    expect(called).toBe(0);
    expect(run.compensation).toBeUndefined();
  });

  it("cancelled_run_does_not_compensate", async () => {
    const ac = new AbortController();
    let called = 0;
    const wf = Workflow.create({ name: "cancel" })
      .then(fn("a", () => 1, { compensate: () => void called++ }))
      .then(
        fn("b", () => {
          ac.abort();
          throw new Error("late");
        }),
      )
      .commit();
    const run = await wf.run(0, { signal: ac.signal });
    expect(called).toBe(0);
    expect(run.compensation).toBeUndefined();
  });

  it("nested_compensate_still_refused", async () => {
    const wf = Workflow.create({ name: "nested" })
      .parallel([[fn("x", () => 1, { compensate: () => undefined })]], { id: "p" })
      .commit();
    const run = await wf.run(0);
    expect(run.status).toBe("failed");
    // The parallel step wraps the nested error, so check the nested dispatch path directly.
    const step = fn("x", () => 1, { compensate: () => undefined });
    const nested = await runFnStep(
      step,
      0,
      makeStepContext("r", new AbortController().signal, {
        getState: () => undefined,
        setState: () => undefined,
      }),
    );
    expect(nested.status).toBe("failed");
    expect(nested.error?.name).toBe("WorkflowCompensateNotImplementedError");
    expect(nested.error?.message).toContain("top-level");
  });

  it("stream_emits_compensation_events", async () => {
    const { wf } = build({ failB: true });
    const stream = wf.stream(1);
    const events: WorkflowEvent[] = [];
    for await (const e of stream) events.push(e);
    const comp = events.filter((e) => e.type.startsWith("step_compensat"));
    expect(comp).toEqual([
      {
        type: "step_compensation_failed",
        stepId: "b",
        error: { name: "Error", message: "undo b broke" },
      },
      { type: "step_compensated", stepId: "a" },
    ]);
  });
});
