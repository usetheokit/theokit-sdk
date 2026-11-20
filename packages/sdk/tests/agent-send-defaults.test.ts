/**
 * #1020 — `AgentOptions.sendDefaults` reaches every local send, merged per key.
 * Observes what the agent loop receives (the seam `toolResultPolicyInputs` forwards to).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loopInputs: Array<Record<string, unknown>> = [];

vi.mock("../src/internal/agent-loop/loop.js", () => ({
  runAgentLoop: vi.fn(async (inputs: Record<string, unknown>) => {
    loopInputs.push(inputs);
    return { events: [], finalStatus: "completed", result: "ok", conversation: [] };
  }),
}));

import { z } from "zod";
import { Agent } from "../src/agent.js";
import { ConfigurationError } from "../src/errors.js";
import { applyToolResultGuard } from "../src/internal/agent-loop/tool-result-guard.js";
import { clearAgentRegistry } from "../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../src/internal/session/agent-session.js";
import type { AgentOptions } from "../src/types/agent.js";

let cwd: string;
beforeEach(async () => {
  loopInputs.length = 0;
  cwd = await mkdtemp(join(tmpdir(), "send-defaults-"));
});
afterEach(async () => {
  clearAgentRegistry();
  clearAllSessions();
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const base = (extra: Partial<AgentOptions> = {}): AgentOptions => ({
  apiKey: "sk-ant-test-key",
  model: { id: "claude-sonnet-4-6" },
  local: { cwd },
  ...extra,
});

describe("AgentOptions.sendDefaults (#1020)", () => {
  it("a plain send wraps a tool result in <untrusted-tool-output>", async () => {
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true } } }),
    );
    await (await agent.send("hi")).wait();
    const guard = loopInputs[0]?.toolResultGuard as { delimit?: boolean };
    expect(guard).toEqual({ delimit: true });
    const guarded = applyToolResultGuard(
      [{ type: "tool_result", toolUseId: "t1", content: "tool text" } as never],
      guard as never,
    );
    expect(JSON.stringify(guarded)).toContain("<untrusted-tool-output>");
  });

  it("a call's toolResultGuard replaces the default", async () => {
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true } } }),
    );
    await (await agent.send("hi", { toolResultGuard: { redactPii: true } })).wait();
    expect(loopInputs[0]?.toolResultGuard).toEqual({ redactPii: true });
  });

  it("an explicit undefined does not remove the default; other call keys survive", async () => {
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true }, perToolTimeoutMs: 500 } }),
    );
    await (await agent.send("hi", { toolResultGuard: undefined, perToolTimeoutMs: 9 })).wait();
    expect(loopInputs[0]?.toolResultGuard).toEqual({ delimit: true });
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(9);
  });

  it("forwards pruning and timeout defaults", async () => {
    const agent = await Agent.create(
      base({ sendDefaults: { pruneToolResults: { olderThanRounds: 2 }, perToolTimeoutMs: 1234 } }),
    );
    await (await agent.send("hi")).wait();
    expect(loopInputs[0]?.pruneToolResults).toEqual({ olderThanRounds: 2 });
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(1234);
  });

  it("rejects an invalid pruning default at create, before any provider call", async () => {
    await expect(
      Agent.create(base({ sendDefaults: { pruneToolResults: { olderThanRounds: 0 } } })),
    ).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
    await expect(
      Agent.create(base({ sendDefaults: { pruneToolResults: { olderThanRounds: 0 } } })),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(loopInputs).toHaveLength(0);
  });

  it("rejects an invalid per-call pruning override before dispatch", async () => {
    const agent = await Agent.create(
      base({ sendDefaults: { pruneToolResults: { olderThanRounds: 2 } } }),
    );
    await expect(
      agent.send("hi", { pruneToolResults: { olderThanRounds: 0 } }),
    ).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
    expect(loopInputs).toHaveLength(0);
  });

  it("resume keeps persisted defaults and validates an invalid override", async () => {
    const agent = await Agent.create(
      base({
        agentId: "agent-send-defaults-resume",
        sendDefaults: { toolResultGuard: { delimit: true } },
      }),
    );
    await Agent.resume(agent.agentId, { apiKey: "sk-ant-test-key", local: { cwd } }).then(
      async (r) => {
        await (await r.send("hi")).wait();
      },
    );
    expect(loopInputs[0]?.toolResultGuard).toEqual({ delimit: true });
    await expect(
      Agent.resume(agent.agentId, {
        apiKey: "sk-ant-test-key",
        local: { cwd },
        sendDefaults: { pruneToolResults: { olderThanRounds: 0 } },
      }),
    ).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
  });

  it("helper sends (generate, runToCompletion) and fork use the defaults", async () => {
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true } } }),
    );
    await agent.runToCompletion?.("go").catch(() => undefined);
    await agent
      .generate("x", { output: z.object({ a: z.string() }), maxRetries: 0 })
      .catch(() => undefined);
    await agent.fork?.({ prompt: "child", allowedTools: new Set<string>() }).catch(() => undefined);
    expect(loopInputs.length).toBeGreaterThanOrEqual(3);
    for (const input of loopInputs) expect(input.toolResultGuard).toEqual({ delimit: true });
  });
});
