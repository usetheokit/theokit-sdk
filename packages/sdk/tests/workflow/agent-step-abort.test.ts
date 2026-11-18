import { describe, expect, it, vi } from "vitest";
import type { SDKAgent } from "../../src/types/agent.js";
import { agentStep, Workflow } from "../../src/workflow.js";

function hanging(cancel: () => void) {
  const send = vi.fn(async () => ({ cancel, wait: () => new Promise<never>(() => {}) }));
  return { agent: { agentId: "h", send } as unknown as SDKAgent, send };
}

const retry = { maxAttempts: 3, initialBackoffMs: 5 };

describe("agentStep cancellation", () => {
  it("an aborted signal cancels the in-flight agent run", async () => {
    const cancel = vi.fn();
    const h = hanging(cancel);
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", h.agent, () => "go"))
      .commit();
    const ctrl = new AbortController();
    const p = wf.run("in", { signal: ctrl.signal });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(run.stepResults[0]?.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("an abort with a retry policy stays cancelled and is not retried", async () => {
    const cancel = vi.fn();
    const h = hanging(cancel);
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", h.agent, () => "go", { retry }))
      .commit();
    const ctrl = new AbortController();
    const p = wf.run("in", { signal: ctrl.signal });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(run.stepResults[0]?.status).toBe("cancelled");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a run that cancels itself with a retry policy is not retried", async () => {
    const send = vi.fn(async () => ({
      wait: async () => ({ id: "r", status: "cancelled" as const }),
    }));
    const agent = { agentId: "c", send } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", agent, () => "go", { retry }))
      .commit();
    const run = await wf.run("in");
    expect(run.status).toBe("cancelled");
    expect(run.stepResults[0]?.status).toBe("cancelled");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("an abort while send is still pending settles cancelled and cancels the late run", async () => {
    const cancel = vi.fn();
    let release: (r: unknown) => void = () => {};
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const agent = { agentId: "p", send } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", agent, () => "go"))
      .commit();
    const ctrl = new AbortController();
    const p = wf.run("in", { signal: ctrl.signal });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    release({ cancel, wait: () => new Promise<never>(() => {}) });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
});
