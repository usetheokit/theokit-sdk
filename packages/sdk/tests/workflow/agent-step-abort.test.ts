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
