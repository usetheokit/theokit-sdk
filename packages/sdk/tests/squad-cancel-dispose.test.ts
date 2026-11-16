import { describe, expect, it, vi } from "vitest";
import { Squad } from "../src/squad.js";
import type { SDKAgent } from "../src/types/agent.js";
import { agentStep, Workflow } from "../src/workflow.js";

function hanging(cancel: () => void, dispose = vi.fn(async () => {})) {
  const send = vi.fn(async () => ({
    cancel,
    wait: () => new Promise<never>(() => {}),
  }));
  return { agent: { agentId: "h", send, dispose } as unknown as SDKAgent, send, dispose };
}
function quick(tag: string, dispose = vi.fn(async () => {})) {
  const send = vi.fn(async (p: string) => ({
    wait: async () => ({ id: tag, status: "finished" as const, result: `${p}>${tag}` }),
  }));
  return { agent: { agentId: tag, send, dispose } as unknown as SDKAgent, send, dispose };
}

describe("Squad.run cancellation", () => {
  it("timeoutMs cancels the first member and reports timedOut", async () => {
    await Squad.create({ agents: [quick("warm").agent] }).run("x"); // warm lazy imports
    const cancel = vi.fn();
    const h = hanging(cancel);
    const run = await Squad.create({ agents: [h.agent] }).run("x", { timeoutMs: 50 });
    expect(run.status).toBe("cancelled");
    expect(run.timedOut).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("aborting during the second member cancels it and skips the third", async () => {
    const cancel = vi.fn();
    const a = quick("a");
    const b = hanging(cancel);
    const c = quick("c");
    const ctrl = new AbortController();
    const p = Squad.create({ agents: [a.agent, b.agent, c.agent] }).run("x", {
      signal: ctrl.signal,
    });
    await vi.waitFor(() => expect(b.send).toHaveBeenCalled());
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(run.timedOut).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(c.send).not.toHaveBeenCalled();
  });

  it("an agentStep workflow with an aborted signal cancels the in-flight run", async () => {
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

  it("an already aborted signal never calls Agent.create", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const run = await Squad.create({ agents: [{ description: "d", prompt: "p" }] }).run("x", {
      signal: ctrl.signal,
    });
    expect(run.status).toBe("cancelled");
  });
});

describe("Squad ownsMembers disposal", () => {
  it("disposes passed-in members after completed and cancelled runs only when owned", async () => {
    const a = quick("a");
    await Squad.create({ agents: [a.agent], ownsMembers: true }).run("x");
    expect(a.dispose).toHaveBeenCalledTimes(1);
    const h = hanging(vi.fn());
    await Squad.create({ agents: [h.agent], ownsMembers: true }).run("x", { timeoutMs: 20 });
    expect(h.dispose).toHaveBeenCalledTimes(1);
    const d = quick("d");
    await Squad.create({ agents: [d.agent] }).run("x");
    expect(d.dispose).not.toHaveBeenCalled();
  });

  it("a rejecting dispose does not change the result and reaches onDisposeError", async () => {
    const boom = new Error("boom");
    const a = quick(
      "a",
      vi.fn(async () => Promise.reject(boom)),
    );
    const b = quick("b");
    const onDisposeError = vi.fn();
    const run = await Squad.create({
      agents: [a.agent, b.agent],
      ownsMembers: true,
      onDisposeError,
    }).run("x");
    expect(run.status).toBe("completed");
    expect(run.result).toBe("x>a>b");
    expect(onDisposeError).toHaveBeenCalledWith(boom, 0);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it("registers passed-in members before materializing a failing definition", async () => {
    const ctrl = new AbortController();
    const later = quick("later");
    ctrl.abort();
    await Squad.create({
      agents: [{ description: "d", prompt: "p" }, later.agent],
      ownsMembers: true,
    }).run("x", {
      signal: ctrl.signal,
    });
    expect(later.dispose).toHaveBeenCalledTimes(1);
  });
});
