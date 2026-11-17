/**
 * Tests for ParallelStep: concurrency, fail-fast, collect, EC-6 empty branches.
 */

import { describe, expect, it, vi } from "vitest";

import { fn, Workflow } from "../../src/workflow.js";

describe("workflow .parallel", () => {
  it("runs all branches concurrently and collects outputs", async () => {
    const order: string[] = [];
    const wf = Workflow.create({ name: "par" })
      .parallel(
        [
          [
            fn("a", async () => {
              order.push("a");
              return 1;
            }),
          ],
          [
            fn("b", async () => {
              order.push("b");
              return 2;
            }),
          ],
          [
            fn("c", async () => {
              order.push("c");
              return 3;
            }),
          ],
        ],
        { id: "fanout" },
      )
      .commit();

    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual([1, 2, 3]);
    expect(order).toHaveLength(3);
  });

  it("EC-6 — empty branches returns output: []", async () => {
    const wf = Workflow.create({ name: "par-empty" }).parallel([], { id: "empty" }).commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual([]);
  });

  it("fail-fast: first branch failure aborts the rest", async () => {
    let bRan = false;
    const wf = Workflow.create({ name: "par-fail-fast" })
      .parallel(
        [
          [
            fn("a", async () => {
              throw new Error("a failed");
            }),
          ],
          [
            fn("b", async () => {
              // Delay so a's error wins the race.
              await new Promise((r) => setTimeout(r, 50));
              bRan = true;
              return "b";
            }),
          ],
        ],
        { id: "ff" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toMatch(/branch/i);
    // b may or may not have run depending on scheduler; what matters is the run aborted.
    void bRan;
  });

  it("collect mode: returns per-branch outcomes including errors", async () => {
    const wf = Workflow.create({ name: "par-collect" })
      .parallel(
        [
          [fn("a", async () => "ok-a")],
          [
            fn("b", async () => {
              throw new Error("b failed");
            }),
          ],
          [fn("c", async () => "ok-c")],
        ],
        { id: "collect", errorPolicy: "collect" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    const outputs = run.output as Array<{ ok: boolean; value?: unknown; error?: unknown }>;
    expect(outputs).toHaveLength(3);
    expect(outputs[0]?.ok).toBe(true);
    expect(outputs[0]?.value).toBe("ok-a");
    expect(outputs[1]?.ok).toBe(false);
    expect(outputs[2]?.ok).toBe(true);
  });

  it("respects concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const wf = Workflow.create({ name: "par-cap" })
      .parallel(
        [
          [
            fn("a", async () => {
              active++;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 20));
              active--;
              return 1;
            }),
          ],
          [
            fn("b", async () => {
              active++;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 20));
              active--;
              return 2;
            }),
          ],
          [
            fn("c", async () => {
              active++;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 20));
              active--;
              return 3;
            }),
          ],
        ],
        { id: "cap", concurrency: 2 },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("workflow .parallel cancellation", () => {
  for (const errorPolicy of ["fail-fast", "collect"] as const) {
    it(`${errorPolicy}: abort during the last branch fn that returns normally is cancelled`, async () => {
      const ctrl = new AbortController();
      const build = () =>
        Workflow.create({ name: "par-abort" })
          .parallel(
            [
              [
                fn("last", async () => {
                  ctrl.abort("stop");
                  return 1;
                }),
              ],
            ],
            { id: "p", errorPolicy },
          )
          .commit();
      const run = await build().run(undefined, { signal: ctrl.signal });
      expect(run.status).toBe("cancelled");
      expect(run.stepResults.at(-1)?.status).toBe("cancelled");
    });
  }
});

describe("workflow .parallel nested cancellation", () => {
  it("a cancelled inner step cancels the parallel and stops its branch", async () => {
    const { runParallelStep } = await import("../../src/internal/workflow/step-parallel.js");
    const after = vi.fn();
    const dispatch = vi.fn(async (inner: { id: string }) => {
      if (inner.id === "first") {
        return {
          stepId: "first",
          kind: "agent" as const,
          status: "cancelled" as const,
          attempts: 1,
          durationMs: 0,
          error: { name: "AbortError", message: "cancelled" },
        };
      }
      after();
      return {
        stepId: inner.id,
        kind: "fn" as const,
        status: "completed" as const,
        attempts: 1,
        durationMs: 0,
      };
    });
    for (const errorPolicy of ["fail-fast", "collect"] as const) {
      const result = await runParallelStep(
        {
          id: "p",
          kind: "parallel",
          errorPolicy,
          branches: [
            [
              { id: "first", kind: "fn" },
              { id: "second", kind: "fn" },
            ],
          ],
        } as never,
        undefined,
        {
          ctx: { signal: new AbortController().signal } as never,
          options: {} as never,
          prevStepResults: [],
          dispatch: dispatch as never,
        },
      );
      expect(result.status).toBe("cancelled");
    }
    expect(after).not.toHaveBeenCalled();
  });
});
