/**
 * Tests for branch / foreach / dowhile primitives, including EC-2 (predicate throw),
 * EC-7 (foreach iterableFrom invalid), and max-iterations safety.
 */

import { describe, expect, it, vi } from "vitest";

import { fn, Workflow } from "../../src/workflow.js";

describe("workflow .branch", () => {
  it("first matching predicate runs", async () => {
    const wf = Workflow.create({ name: "br" })
      .then(fn("seed", async () => 5))
      .branch(
        [
          [(i) => (i as number) > 10, [fn("big", async () => "big")]],
          [(i) => (i as number) <= 10, [fn("small", async () => "small")]],
        ],
        { id: "decide" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toBe("small");
  });

  it("EC-2 — predicate that throws is treated as no-match (with warn)", async () => {
    const wf = Workflow.create({ name: "br-throw" })
      .then(fn("seed", async () => ({ value: 5 })))
      .branch(
        [
          [
            (i) => (i as { foo: { bar: number } }).foo.bar > 0, // TypeError
            [fn("never", async () => "never")],
          ],
          [(i) => (i as { value: number }).value > 0, [fn("fallback", async () => "ok")]],
        ],
        { id: "decide" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toBe("ok");
  });

  it("no match + no fallback passes input through unchanged (skipped)", async () => {
    const wf = Workflow.create({ name: "br-skip" })
      .then(fn("seed", async () => 42))
      .branch([[(i) => (i as number) < 0, [fn("never", async () => "never")]]], { id: "decide" })
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toBe(42);
    expect(run.stepResults[1]?.status).toBe("skipped");
  });

  it("runs fallback when no predicate matches", async () => {
    const wf = Workflow.create({ name: "br-fb" })
      .then(fn("seed", async () => 0))
      .branch([[(i) => (i as number) > 100, [fn("never", async () => "never")]]], {
        id: "decide",
        fallback: [fn("fb", async () => "fallback-ran")],
      })
      .commit();
    const run = await wf.run(undefined);
    expect(run.output).toBe("fallback-ran");
  });
});

describe("workflow .foreach", () => {
  it("maps a step over upstream array output", async () => {
    const wf = Workflow.create({ name: "fe" })
      .then(fn("seed", async () => [1, 2, 3]))
      .foreach(
        "seed",
        fn("double", async (i) => (i as number) * 2),
        { id: "mapper" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual([2, 4, 6]);
  });

  it("EC-7 — iterableFrom referencing missing step fails with helpful error", async () => {
    const wf = Workflow.create({ name: "fe-bad" })
      .then(fn("seed", async () => [1, 2, 3]))
      .foreach(
        "nonexistent",
        fn("noop", async (i) => i),
        { id: "mapper" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toMatch(/iterableFrom.*not found/i);
  });

  it("fails helpfully when source output is not an array", async () => {
    const wf = Workflow.create({ name: "fe-not-array" })
      .then(fn("seed", async () => "not-array"))
      .foreach(
        "seed",
        fn("noop", async (i) => i),
        { id: "mapper" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toMatch(/must be Array/i);
  });

  it("empty array completes with output: []", async () => {
    const wf = Workflow.create({ name: "fe-empty" })
      .then(fn("seed", async () => [] as number[]))
      .foreach(
        "seed",
        fn("noop", async (i) => i),
        { id: "mapper" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual([]);
  });
});

describe("workflow .dowhile", () => {
  it("loops until condFn returns false", async () => {
    let i = 0;
    const wf = Workflow.create({ name: "dw" })
      .dowhile(
        fn("inc", async () => {
          i += 1;
          return i;
        }),
        (out) => (out as number) < 3,
        { id: "loop" },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("completed");
    expect(run.output).toBe(3);
  });

  it("throws WorkflowMaxIterationsExceededError when cap reached", async () => {
    const wf = Workflow.create({ name: "dw-cap" })
      .dowhile(
        fn("inc", async () => 1),
        () => true, // always true
        { id: "infinite", maxIterations: 5 },
      )
      .commit();
    const run = await wf.run(undefined);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toMatch(/exceeded max iterations \(5\)/i);
  });
});

describe("workflow .foreach cancellation", () => {
  it("a self-cancelled item aborts its siblings and the step resolves cancelled", async () => {
    const { runForeachStep } = await import("../../src/internal/workflow/step-foreach.js");
    const cancel = vi.fn();
    const dispatch = vi.fn(
      async (_s: unknown, item: unknown, e: { ctx: { signal: AbortSignal } }) => {
        if (item === "self") {
          return {
            stepId: "x",
            kind: "agent" as const,
            status: "cancelled" as const,
            attempts: 1,
            durationMs: 0,
            error: { name: "AbortError", message: "cancelled" },
          };
        }
        await new Promise<void>((resolve) =>
          e.ctx.signal.addEventListener("abort", () => {
            cancel();
            resolve();
          }),
        );
        return {
          stepId: "x",
          kind: "agent" as const,
          status: "completed" as const,
          attempts: 1,
          durationMs: 0,
        };
      },
    );
    const ctx = { signal: new AbortController().signal } as never;
    const result = await runForeachStep(
      {
        id: "fe",
        kind: "foreach",
        iterableFrom: "src",
        step: { id: "x", kind: "fn" },
        concurrency: 2,
      } as never,
      undefined,
      {
        ctx,
        options: {} as never,
        prevStepResults: [
          {
            stepId: "src",
            kind: "fn",
            status: "completed",
            attempts: 1,
            durationMs: 0,
            output: ["hang", "self"],
          },
        ],
        dispatch: dispatch as never,
      },
    );
    expect(result.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("workflow .foreach over a parallel step", () => {
  it("a branch that cancels aborts its siblings, and the foreach resolves cancelled", async () => {
    const { runForeachStep } = await import("../../src/internal/workflow/step-foreach.js");
    const { runParallelStep } = await import("../../src/internal/workflow/step-parallel.js");
    for (const errorPolicy of ["fail-fast", "collect"] as const) {
      const result = (r: "cancelled" | "completed") => ({
        stepId: "x",
        kind: "fn" as const,
        status: r,
        attempts: 1,
        durationMs: 0,
        ...(r === "cancelled" ? { error: { name: "AbortError", message: "cancelled" } } : {}),
      });
      const dispatch = vi.fn(
        async (
          s: { id: string; kind: string },
          _i: unknown,
          e: { ctx: { signal: AbortSignal } },
        ) => {
          if (s.kind === "parallel") {
            return runParallelStep(s as never, undefined, { ...e, dispatch } as never);
          }
          if (s.id === "cancels") return result("cancelled");
          await new Promise<void>((resolve) =>
            e.ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return result("completed");
        },
      );
      const out = await runForeachStep(
        {
          id: "fe",
          kind: "foreach",
          iterableFrom: "src",
          concurrency: 1,
          step: {
            id: "par",
            kind: "parallel",
            errorPolicy,
            branches: [[{ id: "cancels", kind: "fn" }], [{ id: "hangs", kind: "fn" }]],
          },
        } as never,
        undefined,
        {
          ctx: { signal: new AbortController().signal } as never,
          options: {} as never,
          prevStepResults: [
            {
              stepId: "src",
              kind: "fn",
              status: "completed",
              attempts: 1,
              durationMs: 0,
              output: [1],
            },
          ],
          dispatch: dispatch as never,
        },
      );
      expect(out.status).toBe("cancelled");
    }
  });
});

describe("workflow .foreach over a parallel step, an item cancelling itself", () => {
  it("a parallel step in a sibling item finishes under both policies", async () => {
    const { runForeachStep } = await import("../../src/internal/workflow/step-foreach.js");
    const { runParallelStep } = await import("../../src/internal/workflow/step-parallel.js");
    for (const errorPolicy of ["fail-fast", "collect"] as const) {
      const res = (status: "cancelled" | "completed") => ({
        stepId: "x",
        kind: "fn" as const,
        status,
        attempts: 1,
        durationMs: 0,
        ...(status === "cancelled" ? { error: { name: "AbortError", message: "cancelled" } } : {}),
      });
      const dispatch = vi.fn(
        async (s: { id: string; kind: string }, item: unknown, e: { ctx: { signal: AbortSignal } }) => {
          if (s.kind === "parallel") {
            return runParallelStep(s as never, item, { ...e, dispatch } as never);
          }
          if (item === "self") return res("cancelled");
          // Like a run that only learns of an abort that happens while it is waiting.
          await new Promise<void>((resolve) =>
            e.ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return res("completed");
        },
      );
      const run = runForeachStep(
        {
          id: "fe",
          kind: "foreach",
          iterableFrom: "src",
          concurrency: 2,
          step: {
            id: "par",
            kind: "parallel",
            errorPolicy,
            concurrency: 1,
            branches: [[{ id: "a", kind: "fn" }], [{ id: "b", kind: "fn" }]],
          },
        } as never,
        undefined,
        {
          ctx: { signal: new AbortController().signal } as never,
          options: {} as never,
          prevStepResults: [
            { stepId: "src", kind: "fn", status: "completed", attempts: 1, durationMs: 0, output: ["hang", "self"] },
          ],
          dispatch: dispatch as never,
        },
      );
      const out = await Promise.race([
        run,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000)),
      ]);
      expect(out === "timeout" ? out : out.status).toBe("cancelled");
    }
  });
});
