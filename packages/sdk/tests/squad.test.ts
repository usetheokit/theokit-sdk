/**
 * Tests for Squad — sequential multi-agent team (cross-val Gap 1, narrowed).
 *
 * Squad is a THIN convenience that COMPOSES Workflow + agentStep (no new
 * orchestration engine). It runs agents in order, threading each agent's
 * output into the next agent's prompt.
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../src/errors.js";
import { setDiagnosticsSink } from "../src/internal/diagnostics.js";
import { Squad } from "../src/squad.js";
import type { SDKAgent } from "../src/types/agent.js";

/**
 * Fake agent: records the prompt it received, returns `${prompt}>${tag}` so a
 * threaded chain is observable in the final output.
 */
function fakeAgent(tag: string, seen: string[]): SDKAgent {
  return {
    agentId: `fake-${tag}`,
    async send(message: string | { text: string }) {
      const prompt = typeof message === "string" ? message : message.text;
      seen.push(prompt);
      return {
        wait: async () => ({
          id: `run-${tag}`,
          status: "finished" as const,
          result: `${prompt}>${tag}`,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      };
    },
  } as unknown as SDKAgent;
}

describe("Squad — sequential threading", () => {
  it("test_createSquad_runs_agents_sequentially_threading_output", async () => {
    const seen: string[] = [];
    const squad = Squad.create({
      agents: [fakeAgent("a", seen), fakeAgent("b", seen), fakeAgent("c", seen)],
    });
    const run = await squad.run("start");
    // a sees "start"; b sees a's output "start>a"; c sees "start>a>b".
    expect(seen).toEqual(["start", "start>a", "start>a>b"]);
    expect(run.result).toBe("start>a>b>c");
    expect(run.status).toBe("completed");
  });

  it("test_createSquad_returns_per_agent_trace", async () => {
    const seen: string[] = [];
    const squad = Squad.create({ agents: [fakeAgent("a", seen), fakeAgent("b", seen)] });
    const run = await squad.run("go");
    expect(run.steps).toHaveLength(2);
    expect(run.steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("test_default_process_is_sequential", async () => {
    const seen: string[] = [];
    const squad = Squad.create({ agents: [fakeAgent("a", seen)] }); // no process specified
    const run = await squad.run("x");
    expect(run.result).toBe("x>a");
  });
});

describe("Squad — validation (fail-fast)", () => {
  it("test_rejects_empty_agents", () => {
    expect(() => Squad.create({ agents: [] })).toThrowError(ConfigurationError);
    try {
      Squad.create({ agents: [] });
    } catch (e) {
      expect((e as ConfigurationError).code).toBe("invalid_squad");
    }
  });

  it("test_rejects_hierarchical_with_guidance", () => {
    const seen: string[] = [];
    expect(() =>
      Squad.create({ agents: [fakeAgent("a", seen)], process: "hierarchical" }),
    ).toThrowError(ConfigurationError);
    try {
      Squad.create({ agents: [fakeAgent("a", seen)], process: "hierarchical" });
    } catch (e) {
      expect((e as ConfigurationError).code).toBe("squad_process_unsupported");
      // guidance points to the existing delegation primitives
      expect((e as Error).message.toLowerCase()).toMatch(/subagent|handoff/);
    }
  });
});

function hangingAgent(cancel: () => void, dispose = vi.fn(async () => {})) {
  const send = vi.fn(async () => ({ cancel, wait: () => new Promise<never>(() => {}) }));
  return { agent: { agentId: "h", send, dispose } as unknown as SDKAgent, send, dispose };
}
function quickAgent(tag: string, dispose = vi.fn(async () => {})) {
  const send = vi.fn(async (p: string) => ({
    wait: async () => ({ id: tag, status: "finished" as const, result: `${p}>${tag}` }),
  }));
  return { agent: { agentId: tag, send, dispose } as unknown as SDKAgent, send, dispose };
}

describe("Squad.run cancellation", () => {
  it("timeoutMs cancels the first member and reports timedOut", async () => {
    await Squad.create({ agents: [quickAgent("warm").agent] }).run("x"); // warm lazy imports
    const cancel = vi.fn();
    const h = hangingAgent(cancel);
    const run = await Squad.create({ agents: [h.agent] }).run("x", { timeoutMs: 50 });
    expect(run.status).toBe("cancelled");
    expect(run.timedOut).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("aborting during the second member cancels it and skips the third", async () => {
    const cancel = vi.fn();
    const a = quickAgent("a");
    const b = hangingAgent(cancel);
    const c = quickAgent("c");
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

  it("an external abort that precedes the timer does not report timedOut", async () => {
    const h = hangingAgent(vi.fn());
    const ctrl = new AbortController();
    const p = Squad.create({ agents: [h.agent] }).run("x", { signal: ctrl.signal, timeoutMs: 60 });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 120));
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(run.timedOut).toBeUndefined();
  });
});

describe("Squad ownsMembers disposal", () => {
  it("disposes passed-in members once after completed and cancelled runs, none by default", async () => {
    const a = quickAgent("a");
    await Squad.create({ agents: [a.agent], ownsMembers: true }).run("x");
    expect(a.dispose).toHaveBeenCalledTimes(1);
    const h = hangingAgent(vi.fn());
    await Squad.create({ agents: [h.agent], ownsMembers: true }).run("x", { timeoutMs: 20 });
    expect(h.dispose).toHaveBeenCalledTimes(1);
    const d = quickAgent("d");
    await Squad.create({ agents: [d.agent] }).run("x");
    expect(d.dispose).not.toHaveBeenCalled();
  });

  it("a rejecting dispose does not change the result and reaches onDisposeError", async () => {
    const boom = new Error("boom");
    const a = quickAgent(
      "a",
      vi.fn(async () => Promise.reject(boom)),
    );
    const b = quickAgent("b");
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

  it("the default disposal diagnostic is redacted", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnop1234567890";
    const a = quickAgent(
      "a",
      vi.fn(async () => Promise.reject(new Error(`token ${secret}`))),
    );
    const messages: string[] = [];
    setDiagnosticsSink((m) => messages.push(m));
    try {
      const run = await Squad.create({ agents: [a.agent], ownsMembers: true }).run("x");
      expect(run.status).toBe("completed");
    } finally {
      setDiagnosticsSink(undefined);
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain(secret);
    expect(messages[0]).toContain("squad member 0");
  });

  it("disposes passed-in members even when a later definition fails to materialize", async () => {
    const { Agent } = await import("../src/agent.js");
    const spy = vi.spyOn(Agent, "create").mockRejectedValue(new Error("create failed"));
    const first = quickAgent("first");
    const last = quickAgent("last");
    try {
      await expect(
        Squad.create({
          agents: [first.agent, { description: "d", prompt: "p" }, last.agent],
          ownsMembers: true,
        }).run("x"),
      ).rejects.toThrow("create failed");
    } finally {
      spy.mockRestore();
    }
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(last.dispose).toHaveBeenCalledTimes(1);
  });
});
