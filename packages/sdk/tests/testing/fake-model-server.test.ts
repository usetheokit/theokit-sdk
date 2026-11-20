import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../src/index.js";
import {
  type FakeModelRequest,
  type FakeModelServer,
  startFakeModelServer,
} from "../../src/testing/index.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

useTempCwd();

const servers: FakeModelServer[] = [];
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

async function start(options?: Parameters<typeof startFakeModelServer>[0]) {
  const s = await startFakeModelServer(options);
  servers.push(s);
  return s;
}

async function ask(server: FakeModelServer, prompt = "hi"): Promise<string> {
  const agent = await Agent.create({
    apiKey: "local",
    model: server.model,
    local: { cwd: process.cwd() },
  });
  try {
    const run = await agent.send(prompt);
    let text = "";
    for await (const event of run.stream()) {
      if (event.type !== "assistant") continue;
      for (const part of event.message.content) if (part.type === "text") text += part.text;
    }
    await run.wait();
    return text;
  } finally {
    await agent[Symbol.asyncDispose]?.();
  }
}

describe("startFakeModelServer", () => {
  it.each([
    "openai",
    "ollama",
  ] as const)("an agent completes a send on the %s wire", async (wire) => {
    const server = await start({ wire, reply: "scripted answer" });
    expect(server.model.id.startsWith(wire === "openai" ? "lmstudio/" : "ollama/")).toBe(true);
    expect(await ask(server)).toBe("scripted answer");
  });

  it("two parallel servers get different ports and record only their own request", async () => {
    const [a, b] = await Promise.all([start({ reply: "a" }), start({ reply: "b" })]);
    expect(a.url).not.toBe(b.url);
    const [ra, rb] = await Promise.all([ask(a), ask(b)]);
    expect([ra, rb]).toEqual(["a", "b"]);
    for (const s of [a, b]) {
      expect(s.requests).toHaveLength(1);
      const users = s.requests[0]?.messages.filter((m) => m.role === "user") ?? [];
      expect(JSON.stringify(users.at(-1)?.content)).toContain("hi");
    }
  });

  it("a reply function receives the request", async () => {
    const seen: FakeModelRequest[] = [];
    const server = await start({
      reply: (r) => {
        seen.push(r);
        return `got ${r.messages.length > 0 ? "messages" : "none"}`;
      },
    });
    expect(await ask(server)).toBe("got messages");
    expect(seen).toHaveLength(1);
  });

  it("answers a non-JSON body with 400 and records it", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/v1/chat/completions`, { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.error).toBeTypeOf("string");
  });

  it("refuses a non-loopback host", async () => {
    await expect(startFakeModelServer({ host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });

  it("refuses connections after close()", async () => {
    const server = await startFakeModelServer();
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});
