import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../src/index.js";
import {
  type ScriptedModelServer,
  type ScriptedStep,
  startScriptedModelServer,
  UnconsumedModelStepsError,
  UnexpectedModelCallError,
} from "../../src/testing/index.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

useTempCwd();

const servers: ScriptedModelServer[] = [];
const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_HOST", "THEOKIT_API_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(steps: ScriptedStep[], wire?: "openai" | "ollama") {
  const s = await startScriptedModelServer({ steps, wire });
  servers.push(s);
  return s;
}

let toolRuns = 0;
const ADD = {
  name: "add",
  description: "Add two numbers",
  inputSchema: {
    type: "object" as const,
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  handler: (input: Record<string, unknown>) => {
    toolRuns += 1;
    return String(Number(input.a) + Number(input.b));
  },
};

async function makeAgent(server: ScriptedModelServer) {
  return Agent.create({
    apiKey: "local",
    model: server.model,
    local: { cwd: process.cwd() },
    tools: [ADD],
  });
}

async function send(agent: Awaited<ReturnType<typeof makeAgent>>, prompt: string) {
  const run = await agent.send(prompt);
  let text = "";
  for await (const event of run.stream()) {
    if (event.type !== "assistant") continue;
    for (const part of event.message.content) if (part.type === "text") text += part.text;
  }
  await run.wait();
  return text;
}

describe("startScriptedModelServer", () => {
  beforeEach(() => {
    toolRuns = 0;
  });

  it.each([
    "openai",
    "ollama",
  ] as const)("scripted_server_drives_a_tool_call (%s wire)", async (wire) => {
    const server = await start(
      [{ toolCalls: [{ name: "add", input: { a: 1, b: 2 } }] }, { text: "3" }],
      wire,
    );
    const agent = await makeAgent(server);
    try {
      expect(await send(agent, "add 1 and 2")).toBe("3");
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
    expect(toolRuns).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(JSON.stringify(server.requests[1]?.messages)).toContain("3");
    expect(() => server.assertConsumed()).not.toThrow();
  });

  it("extra_model_call_is_reported", async () => {
    const server = await start([{ text: "one" }]);
    const agent = await makeAgent(server);
    try {
      await send(agent, "a");
      await send(agent, "b").catch(() => undefined);
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
    let caught: unknown;
    try {
      server.assertConsumed();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnexpectedModelCallError);
    expect((caught as Error).message).toContain("call 2");
    expect((caught as { code?: string }).code).toBe("unexpected_model_call");
  });

  it("missing_model_call_is_reported", async () => {
    const server = await start([{ text: "one" }, { text: "two" }]);
    const agent = await makeAgent(server);
    try {
      await send(agent, "a");
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
    let caught: unknown;
    try {
      server.assertConsumed();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnconsumedModelStepsError);
    expect((caught as Error).message).toContain("1 scripted");
    expect((caught as { code?: string }).code).toBe("unconsumed_model_steps");
  });

  it("injected_429_is_retried", async () => {
    const server = await start([{ error: { status: 429, retryAfterSeconds: 0 } }, { text: "ok" }]);
    const agent = await makeAgent(server);
    try {
      expect(await send(agent, "hi")).toBe("ok");
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
    expect(server.requests).toHaveLength(2);
    expect(() => server.assertConsumed()).not.toThrow();
  });
});
