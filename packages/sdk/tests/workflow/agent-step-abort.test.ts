import { describe, expect, it, vi } from "vitest";
import type { SDKAgent } from "../../src/types/agent.js";
import { agentStep, fn, Workflow } from "../../src/workflow.js";

describe("agentStep — abort cancels the in-flight run", () => {
  it("calls run.cancel() when the signal aborts mid-run", async () => {
    let sent!: () => void;
    const sentP = new Promise<void>((r) => {
      sent = r;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cancel = vi.fn(async () => release?.());
    const agent = {
      agentId: "a",
      async send() {
        sent();
        return {
          cancel,
          wait: async () => {
            await gate;
            return { id: "r", status: "cancelled" as const };
          },
        };
      },
    } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", agent, () => "go"))
      .commit();
    const ctrl = new AbortController();
    const p = wf.run("in", { signal: ctrl.signal });
    await sentP;
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(run.stepResults[0]?.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("agentStep — abort edge cases", () => {
  it("settles even when wait() stays pending after cancel()", async () => {
    let sent!: () => void;
    const sentP = new Promise<void>((r) => {
      sent = r;
    });
    const cancel = vi.fn(async () => undefined);
    const agent = {
      agentId: "a",
      async send() {
        sent();
        return { cancel, wait: () => new Promise<never>(() => undefined) };
      },
    } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", agent, () => "go"))
      .commit();
    const ctrl = new AbortController();
    const p = wf.run("in", { signal: ctrl.signal });
    await sentP;
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("never retries a cancelled member result, even with a custom nonRetryableErrors", async () => {
    const send = vi.fn(async () => ({
      cancel: async () => undefined,
      wait: async () => ({ id: "r", status: "cancelled" as const }),
    }));
    const agent = { agentId: "a", send } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .then(
        agentStep("s", agent, () => "go", {
          retry: { maxAttempts: 3, initialBackoffMs: 1, nonRetryableErrors: ["Other"] },
        }),
      )
      .commit();
    const run = await wf.run("in");
    expect(send).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("cancelled");
  });

  it("a cancelled agent inside a branch stops the workflow before later steps", async () => {
    const after = vi.fn(() => "x");
    const agent = {
      agentId: "a",
      async send() {
        return {
          cancel: async () => undefined,
          wait: async () => ({ id: "r", status: "cancelled" as const }),
        };
      },
    } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .branch([[() => true, [agentStep("s", agent, () => "go")]]])
      .then(fn("after", async () => after()))
      .commit();
    const run = await wf.run("in");
    expect(run.status).toBe("cancelled");
    expect(after).not.toHaveBeenCalled();
  });
});

function hangingAgent(onSend: () => void, cancel: () => Promise<void>): SDKAgent {
  return {
    agentId: "a",
    async send() {
      onSend();
      return { cancel, wait: () => new Promise<never>(() => undefined) };
    },
  } as unknown as SDKAgent;
}

describe("agentStep — startup cancellation", () => {
  it("resolves cancelled while send is pending and cancels the run it returns later", async () => {
    let finishSend!: (r: unknown) => void;
    const cancel = vi.fn(async () => undefined);
    const agent = {
      agentId: "a",
      send: () =>
        new Promise((r) => {
          finishSend = r;
        }),
    } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", agent, () => "go"))
      .commit();
    const ctrl = new AbortController();
    const p = wf.run("in", { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    finishSend({ cancel, wait: () => new Promise(() => undefined) });
    await new Promise((r) => setTimeout(r, 10));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("containers — cancellation stops later dispatch", () => {
  it.each([
    "fail-fast",
    "collect",
  ] as const)("parallel (%s) with bounded concurrency cancels and does not send queued agents", async (errorPolicy) => {
    const ctrl = new AbortController();
    const sends = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const queued = vi.fn(() => "q");
    const wf = Workflow.create({ name: "w" })
      .parallel(
        [
          [
            agentStep(
              "a1",
              hangingAgent(() => {
                sends();
                ctrl.abort();
              }, cancel),
              () => "go",
            ),
          ],
          [agentStep("a2", hangingAgent(sends, cancel), () => "go")],
          [fn("q", async () => queued())],
        ],
        { concurrency: 1, errorPolicy },
      )
      .commit();
    const run = await wf.run("in", { signal: ctrl.signal });
    expect(run.status).toBe("cancelled");
    expect(sends).toHaveBeenCalledTimes(1);
    expect(queued).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("parallel fail-fast keeps the initiating failure over sibling aborts", async () => {
    const cancel = vi.fn(async () => undefined);
    const wf = Workflow.create({ name: "w" })
      .parallel(
        [
          [
            agentStep(
              "a1",
              hangingAgent(() => undefined, cancel),
              () => "go",
            ),
          ],
          [
            fn("boom", async () => {
              await new Promise((r) => setTimeout(r, 10));
              throw new Error("boom");
            }),
          ],
        ],
        { errorPolicy: "fail-fast" },
      )
      .commit();
    const run = await wf.run("in");
    expect(run.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("parallel fail-fast does not dispatch queued branches after a failure", async () => {
    const queued = vi.fn(() => "q");
    const wf = Workflow.create({ name: "w" })
      .parallel(
        [
          [
            fn("boom", async () => {
              throw new Error("boom");
            }),
          ],
          [fn("q", async () => queued())],
        ],
        { concurrency: 1, errorPolicy: "fail-fast" },
      )
      .commit();
    const run = await wf.run("in");
    expect(run.status).toBe("failed");
    expect(queued).not.toHaveBeenCalled();
  });

  it("foreach returns cancelled and sends no further items", async () => {
    const ctrl = new AbortController();
    const sends = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const agent = hangingAgent(() => {
      sends();
      ctrl.abort();
    }, cancel);
    const wf = Workflow.create({ name: "w" })
      .then(fn("items", async () => [1, 2, 3]))
      .foreach(
        "items",
        agentStep("each", agent, () => "go"),
        { concurrency: 1 },
      )
      .commit();
    const run = await wf.run("in", { signal: ctrl.signal });
    expect(run.status).toBe("cancelled");
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("dowhile returns cancelled and runs no further iteration", async () => {
    const ctrl = new AbortController();
    const sends = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const agent = hangingAgent(() => {
      sends();
      ctrl.abort();
    }, cancel);
    const wf = Workflow.create({ name: "w" })
      .dowhile(
        agentStep("loop", agent, () => "go"),
        () => true,
        { maxIterations: 5 },
      )
      .commit();
    const run = await wf.run("in", { signal: ctrl.signal });
    expect(run.status).toBe("cancelled");
    expect(sends).toHaveBeenCalledTimes(1);
  });
});
