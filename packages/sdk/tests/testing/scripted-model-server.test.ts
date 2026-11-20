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
const savedEnv: Record<string, string | undefined> = {};
const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_HOST", "THEOKIT_API_KEY"];

beforeEach(() => {
  for (const k of KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(steps: readonly ScriptedStep[], wire?: "openai" | "ollama") {
  const s = await startScriptedModelServer({ steps, wire });
  servers.push(s);
  return s;
}

let toolRuns = 0;
const ADD = {
  name: "add",
  description: "Add two numbers.",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
  },
  handler: (input: Record<string, unknown>) => {
    toolRuns += 1;
    return String(Number(input.a) + Number(input.b));
  },
};

async function newAgent(server: ScriptedModelServer) {
  return Agent.create({
    apiKey: "local",
    model: server.model,
    local: { cwd: process.cwd() },
    tools: [ADD],
  });
}

async function sendText(agent: Awaited<ReturnType<typeof newAgent>>, prompt: string) {
  const run = await agent.send(prompt);
  let text = "";
  for await (const event of run.stream()) {
    if (event.type !== "assistant") continue;
    for (const part of event.message.content) if (part.type === "text") text += part.text;
  }
  await run.wait();
  return text;
}

const TOOL_STEPS: ScriptedStep[] = [
  { toolCalls: [{ name: "add", input: { a: 1, b: 2 } }] },
  { text: "3" },
];

describe("startScriptedModelServer", () => {
  beforeEach(() => {
    toolRuns = 0;
  });

  it.each([
    "openai",
    "ollama",
  ] as const)("scripted_server_drives_a_tool_call (%s wire)", async (wire) => {
    const server = await start(TOOL_STEPS, wire);
    const agent = await newAgent(server);
    try {
      expect(await sendText(agent, "add")).toContain("3");
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
    const agent = await newAgent(server);
    try {
      await sendText(agent, "first");
      await sendText(agent, "second").catch(() => undefined);
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
    const err = (() => {
      try {
        server.assertConsumed();
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(UnexpectedModelCallError);
    expect((err as UnexpectedModelCallError).code).toBe("unexpected_model_call");
    expect((err as Error).message).toContain("call 2");
  });

  it("missing_model_call_is_reported", async () => {
    const server = await start([{ text: "one" }, { text: "two" }]);
    const agent = await newAgent(server);
    try {
      await sendText(agent, "first");
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
    const err = (() => {
      try {
        server.assertConsumed();
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(UnconsumedModelStepsError);
    expect((err as UnconsumedModelStepsError).code).toBe("unconsumed_model_steps");
    expect((err as Error).message).toContain("1 scripted");
  });

  it("injected_429_is_retried", async () => {
    const server = await start([{ error: { status: 429, retryAfterSeconds: 0 } }, { text: "ok" }]);
    const agent = await newAgent(server);
    try {
      expect(await sendText(agent, "hi")).toBe("ok");
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
    expect(server.requests).toHaveLength(2);
    expect(() => server.assertConsumed()).not.toThrow();
  });

  it("answers an error step with its status, body and retry-after header", async () => {
    const server = await start([
      { error: { status: 503, body: { why: "x" }, retryAfterSeconds: 7 } },
    ]);
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.json()).toEqual({ why: "x" });
  });

  it("keeps the first unexpected call and close() does not throw", async () => {
    const server = await start([]);
    const post = () => fetch(`${server.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    expect((await post()).status).toBe(500);
    await post();
    expect(() => server.assertConsumed()).toThrow(/call 1/);
    await expect(server.close()).resolves.toBeUndefined();
    servers.length = 0;
  });
});
