/**
 * #1020 — `AgentOptions.sendDefaults` reaches every local send, merged per key.
 *
 * Model-visible behavior is observed on the Anthropic wire stub (what the provider receives);
 * forwarding of pruning/timeout is observed at the loop seam, which is wrapped, not replaced.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const loopInputs: Array<Record<string, unknown>> = [];

vi.mock("../src/internal/agent-loop/loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal/agent-loop/loop.js")>();
  return {
    ...actual,
    runAgentLoop: vi.fn((inputs: Record<string, unknown>) => {
      loopInputs.push(inputs);
      return actual.runAgentLoop(inputs as never);
    }),
  };
});

import { Agent } from "../src/agent.js";
import { Tool } from "../src/define-tool.js";
import { ConfigurationError } from "../src/errors.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../src/internal/session/agent-session.js";
import type { AgentOptions } from "../src/types/agent.js";
import {
  blockStop,
  messageDelta,
  sseFrame,
  textBlockStart,
  textDelta,
  toolBlockStart,
  toolInputDelta,
} from "./helpers/anthropic-sse.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

interface Stub {
  server: Server;
  url: string;
  bodies: Array<{ messages: unknown[] }>;
}

/** Round 1 calls `probe` when `withTool`; every other round replies with `reply`. */
function startStub(withTool: boolean, reply: string, toolRounds = 1): Promise<Stub> {
  const bodies: Stub["bodies"] = [];
  let call = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      call += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(sseFrame("message_start", "{}"));
      if (withTool && call <= toolRounds) {
        res.write(toolBlockStart("tu-1", "probe"));
        res.write(toolInputDelta("{}"));
        res.write(blockStop());
        res.write(messageDelta("tool_use", { input_tokens: 1, output_tokens: 1 }));
      } else {
        res.write(textBlockStart());
        res.write(textDelta(reply));
        res.write(blockStop());
        res.write(messageDelta("end_turn", { input_tokens: 1, output_tokens: 1 }));
      }
      res.write(sseFrame("message_stop", "{}"));
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || a === null) throw new Error("bind failed");
      resolve({ server, url: `http://127.0.0.1:${a.port}`, bodies });
    });
  });
}

const probe = Tool.create({
  name: "probe",
  description: "returns text",
  inputSchema: z.object({}),
  handler: () => "tool text for ada@example.com",
});

const base = (extra: Partial<AgentOptions> = {}): AgentOptions => ({
  apiKey: "real-not-fixture",
  model: { id: "claude-sonnet-4-6" },
  tools: [probe],
  ...extra,
});

describe("AgentOptions.sendDefaults (#1020)", () => {
  useTempCwd();
  let stub: Stub | undefined;
  let prevKey: string | undefined;
  let prevUrl: string | undefined;

  beforeEach(() => {
    loopInputs.length = 0;
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    prevKey = process.env.ANTHROPIC_API_KEY;
    prevUrl = process.env.ANTHROPIC_API_BASE_URL;
  });
  afterEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.ANTHROPIC_API_BASE_URL;
    else process.env.ANTHROPIC_API_BASE_URL = prevUrl;
    if (stub !== undefined) {
      await new Promise<void>((resolve) => stub?.server.close(() => resolve()));
      stub = undefined;
    }
  });

  async function useStub(withTool: boolean, reply = "done", toolRounds = 1): Promise<Stub> {
    stub = await startStub(withTool, reply, toolRounds);
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    return stub;
  }

  /** The tool_result text the provider received on the round after the tool ran. */
  const toolResultSeenByModel = (s: Stub): string => JSON.stringify(s.bodies[1]?.messages);

  it("a plain send delivers the tool result to the model wrapped in <untrusted-tool-output>", async () => {
    const s = await useStub(true);
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true } } }),
    );
    await (await agent.send("go")).wait();
    expect(s.bodies).toHaveLength(2);
    expect(toolResultSeenByModel(s)).toContain("<untrusted-tool-output>");
    expect(toolResultSeenByModel(s)).toContain("tool text for ada@example.com");
    await agent.dispose();
  });

  it("a call's toolResultGuard replaces the default (no delimiting, PII redacted)", async () => {
    const s = await useStub(true);
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true } } }),
    );
    await (await agent.send("go", { toolResultGuard: { redactPii: true } })).wait();
    const seen = toolResultSeenByModel(s);
    expect(seen).not.toContain("untrusted-tool-output");
    expect(seen).toContain("[REDACTED]");
    await agent.dispose();
  });

  it("an explicit undefined does not remove the default; other call keys survive", async () => {
    await useStub(false);
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true }, perToolTimeoutMs: 500 } }),
    );
    await (await agent.send("hi", { toolResultGuard: undefined, perToolTimeoutMs: 9 })).wait();
    expect(loopInputs).toHaveLength(1);
    expect(loopInputs[0]?.toolResultGuard).toEqual({ delimit: true });
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(9);
    await agent.dispose();
  });

  it("forwards pruning and timeout defaults to the loop", async () => {
    await useStub(false);
    const agent = await Agent.create(
      base({ sendDefaults: { pruneToolResults: { olderThanRounds: 2 }, perToolTimeoutMs: 1234 } }),
    );
    await (await agent.send("hi")).wait();
    expect(loopInputs[0]?.pruneToolResults).toEqual({ olderThanRounds: 2 });
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(1234);
    await agent.dispose();
  });

  it("a doomLoop default blocks the repeated call on a send that passes none", async () => {
    const s = await useStub(true, "done", 4);
    const agent = await Agent.create(
      base({ sendDefaults: { doomLoop: { window: 4, windowRepeatLimit: 1 } } }),
    );
    await (await agent.send("go")).wait();
    expect(JSON.stringify(s.bodies.at(-1)?.messages)).toContain("Blocked: `probe`");
    await agent.dispose();
  });

  it("a call's doomLoop wins over the default; false disables the guard", async () => {
    const s = await useStub(true, "done", 3);
    const agent = await Agent.create(
      base({ sendDefaults: { doomLoop: { window: 4, windowRepeatLimit: 1 } } }),
    );
    await (await agent.send("go", { doomLoop: false })).wait();
    expect(JSON.stringify(s.bodies.at(-1)?.messages)).not.toContain("Blocked: `probe`");
    await agent.dispose();
  });

  it("an invalid doomLoop default is rejected at send, and a valid call value overrides it", async () => {
    await useStub(false);
    const agent = await Agent.create(base({ sendDefaults: { doomLoop: { window: 0 } } }));
    await expect(agent.send("hi")).rejects.toBeInstanceOf(ConfigurationError);
    await (await agent.send("hi", { doomLoop: false })).wait();
    await agent.dispose();
  });

  it("rejects an invalid pruning default at create, before any provider call", async () => {
    const s = await useStub(false);
    const create = () =>
      Agent.create(base({ sendDefaults: { pruneToolResults: { olderThanRounds: 0 } } }));
    await expect(create()).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
    await expect(create()).rejects.toBeInstanceOf(ConfigurationError);
    expect(s.bodies).toHaveLength(0);
    expect(loopInputs).toHaveLength(0);
  });

  it("rejects an invalid per-call pruning override before dispatch", async () => {
    const s = await useStub(false);
    const agent = await Agent.create(
      base({ sendDefaults: { pruneToolResults: { olderThanRounds: 2 } } }),
    );
    await expect(
      agent.send("hi", { pruneToolResults: { olderThanRounds: 0 } }),
    ).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
    expect(s.bodies).toHaveLength(0);
    expect(loopInputs).toHaveLength(0);
    await agent.dispose();
  });

  it("resume keeps persisted defaults and validates an invalid override", async () => {
    await useStub(false);
    const agent = await Agent.create(
      base({
        agentId: "agent-send-defaults-resume",
        sendDefaults: { toolResultGuard: { delimit: true } },
      }),
    );
    const resumed = await Agent.resume(agent.agentId, { apiKey: "real-not-fixture" });
    await (await resumed.send("hi")).wait();
    expect(loopInputs).toHaveLength(1);
    expect(loopInputs[0]?.toolResultGuard).toEqual({ delimit: true });
    await expect(
      Agent.resume(agent.agentId, {
        apiKey: "real-not-fixture",
        sendDefaults: { pruneToolResults: { olderThanRounds: 0 } },
      }),
    ).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
  });

  it("runToCompletion, generate and fork each reach the loop with the defaults", async () => {
    await useStub(false, '{"a":"x"}');
    const agent = await Agent.create(
      base({ sendDefaults: { toolResultGuard: { delimit: true }, perToolTimeoutMs: 77 } }),
    );

    await agent.runToCompletion?.("go");
    expect(loopInputs).toHaveLength(1);

    // Phase 1 of generate() is the agent's own send. Phase 2 is a transient structuring agent
    // (output tool only, no tool results to guard) that does not inherit the defaults; the stub
    // never calls the output tool, so it rejects with a typed error rather than being swallowed.
    await expect(
      agent.generate("x", { output: z.object({ a: z.string() }), maxRetries: 0 }),
    ).rejects.toMatchObject({ name: "GenerateObjectError", code: "no_tool_call" });
    expect(loopInputs).toHaveLength(3);
    expect(loopInputs[1]?.toolResultGuard).toEqual({ delimit: true });
    expect(loopInputs[2]?.toolResultGuard).toBeUndefined();

    const forked = await agent.fork?.({ prompt: "child", allowedTools: new Set<string>() });
    expect(forked).toBeDefined();
    expect(loopInputs).toHaveLength(4);

    for (const i of [0, 1, 3]) {
      expect(loopInputs[i]?.toolResultGuard).toEqual({ delimit: true });
      expect(loopInputs[i]?.perToolTimeoutMs).toBe(77);
    }
    await agent.dispose();
  });
});
