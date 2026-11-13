/**
 * Tests for Squad — sequential multi-agent team (cross-val Gap 1, narrowed).
 *
 * Squad is a THIN convenience that COMPOSES Workflow + agentStep (no new
 * orchestration engine). It runs agents in order, threading each agent's
 * output into the next agent's prompt.
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../src/errors.js";
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

/** Agent whose run only finishes when `cancel()` is called. */
function hangingAgent(): {
  agent: SDKAgent;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const cancel = vi.fn(async () => {
    release?.();
  });
  const dispose = vi.fn(async () => undefined);
  const agent = {
    agentId: "fake-hang",
    dispose,
    async send() {
      return {
        cancel,
        wait: async () => {
          await gate;
          return { id: "r", status: "cancelled" as const };
        },
      };
    },
  } as unknown as SDKAgent;
  return { agent, cancel, dispose };
}

function okAgent(tag: string, dispose = vi.fn(async () => undefined)): SDKAgent {
  const a = fakeAgent(tag, []) as unknown as Record<string, unknown>;
  a.dispose = dispose;
  return a as unknown as SDKAgent;
}

describe("Squad.run — cancellation and disposal", () => {
  it("timeoutMs cancels the in-flight run and sets timedOut", async () => {
    const h = hangingAgent();
    const squad = Squad.create({ agents: [h.agent, okAgent("b")] });
    const run = await squad.run("x", { timeoutMs: 50 });
    expect(run.status).toBe("cancelled");
    expect(run.timedOut).toBe(true);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("aborting the signal while the second member runs cancels it; no third call", async () => {
    const h = hangingAgent();
    const third = vi.fn();
    const thirdAgent = { agentId: "t", send: third } as unknown as SDKAgent;
    const ctrl = new AbortController();
    const squad = Squad.create({ agents: [okAgent("a"), h.agent, thirdAgent] });
    const p = squad.run("x", { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(run.timedOut).toBeUndefined();
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
  });

  it("ownsMembers disposes each member once after completed and cancelled runs", async () => {
    const d1 = vi.fn(async () => undefined);
    const d2 = vi.fn(async () => undefined);
    await Squad.create({ agents: [okAgent("a", d1), okAgent("b", d2)], ownsMembers: true }).run(
      "x",
    );
    expect([d1.mock.calls.length, d2.mock.calls.length]).toEqual([1, 1]);

    const h = hangingAgent();
    await Squad.create({ agents: [h.agent], ownsMembers: true }).run("x", { timeoutMs: 20 });
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not dispose members by default", async () => {
    const d = vi.fn(async () => undefined);
    await Squad.create({ agents: [okAgent("a", d)] }).run("x");
    expect(d).not.toHaveBeenCalled();
  });

  it("a rejecting dispose does not change the result; onDisposeError gets error and index", async () => {
    const boom = new Error("boom");
    const onDisposeError = vi.fn();
    const squad = Squad.create({
      agents: [
        okAgent("a"),
        okAgent(
          "b",
          vi.fn(async () => Promise.reject(boom)),
        ),
      ],
      ownsMembers: true,
      onDisposeError,
    });
    const run = await squad.run("x");
    expect(run.status).toBe("completed");
    expect(run.result).toBe("x>a>b");
    expect(onDisposeError).toHaveBeenCalledWith(boom, 1);
  });
});
