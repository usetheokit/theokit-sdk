/**
 * `AgentOptions.modelFallback`: rerun a turn on the next model when it fails before output.
 *
 * Hermetic: a local chat-completions endpoint answers per requested model id.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, ConfigurationError, ModelFallbackExhaustedError, type Run } from "../src/index.js";
import { getSessionMessages } from "../src/internal/session/index.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd("theokit-model-fallback-");

const KEY = "sk-or-stub-0000000000";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
function textChunk(text: string): string {
  return sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

interface Stub {
  server: Server;
  /** Every request's model; the provider client retries a 503 itself, so repeats are expected. */
  models: string[];
}

async function streamedText(run: Run): Promise<string> {
  let text = "";
  for await (const m of run.stream()) {
    if (m.type !== "assistant") continue;
    for (const b of m.message.content) if (b.type === "text") text += b.text;
  }
  return text;
}

const distinct = (xs: string[]): string[] => [...new Set(xs)];

/** `fail/*` → 503; `partial/*` → text then a dropped connection; `slow/*` → hangs; else text. */
async function startStub(): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, models: [] };
  stub.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += String(c);
    });
    req.on("end", () => {
      const model = (JSON.parse(body) as { model: string }).model;
      stub.models.push(model);
      if (model.startsWith("fail/")) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: `no ${model}`, code: 503 } }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      if (model.startsWith("slow/")) return;
      if (model.startsWith("partial/")) {
        res.write(textChunk("half an answ"));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.write(textChunk(`answer from ${model}`));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", () => r()));
  return stub;
}

describe("AgentOptions.modelFallback", () => {
  let stub: Stub;
  beforeEach(async () => {
    stub = await startStub();
    const addr = stub.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_API_BASE_URL = `http://127.0.0.1:${String(addr.port)}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => stub.server.close(() => r()));
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_BASE_URL;
  });

  function create(model: string, fallback: string[]) {
    return Agent.create({
      apiKey: KEY,
      model: { id: model },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
      modelFallback: { models: fallback },
      local: { cwd: process.cwd() },
    });
  }

  it("finishes on the first fallback model with one user message in the transcript", async () => {
    const agent = await create("fail/primary", ["good/one", "good/two"]);
    try {
      const run = await agent.send("hello");
      const streamed = await streamedText(run);
      const result = await run.wait();
      expect(result.status).toBe("finished");
      expect(result.result).toContain("answer from good/one");
      expect(streamed).toContain("answer from good/one");
      expect(distinct(stub.models)).toEqual(["fail/primary", "good/one"]);
      expect(result.modelFallbackAttempts).toEqual([
        expect.objectContaining({ model: "fail/primary" }),
      ]);
      await vi.waitFor(() => expect(getSessionMessages(agent.agentId).length).toBe(2));
      const messages = getSessionMessages(agent.agentId);
      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(messages[1]?.text).toContain("answer from good/one");
    } finally {
      await agent.dispose();
    }
  });

  it("does not fall over once the primary has streamed text", async () => {
    const agent = await create("partial/primary", ["good/one"]);
    try {
      const run = await agent.send("hello");
      const result = await run.wait();
      expect(result.status).toBe("error");
      expect(stub.models).toEqual(["partial/primary"]);
      expect(result.modelFallbackAttempts).toBeUndefined();
    } finally {
      await agent.dispose();
    }
  });

  it("does not fall over when the caller cancels before output", async () => {
    const agent = await create("slow/primary", ["good/one"]);
    try {
      const run = await agent.send("hello");
      await vi.waitFor(() => expect(stub.models).toEqual(["slow/primary"]));
      await run.cancel();
      const result = await run.wait();
      expect(result.status).toBe("cancelled");
      await new Promise((r) => setTimeout(r, 100));
      expect(stub.models).toEqual(["slow/primary"]);
    } finally {
      await agent.dispose();
    }
  });

  it("ends in error with ModelFallbackExhaustedError naming every model", async () => {
    const agent = await create("fail/a", ["fail/b", "fail/c"]);
    try {
      const run = await agent.send("hello");
      const result = await run.wait();
      expect(result.status).toBe("error");
      const cause = result.error?.cause;
      expect(cause).toBeInstanceOf(ModelFallbackExhaustedError);
      for (const m of ["fail/a", "fail/b", "fail/c"]) expect(cause?.message).toContain(m);
      expect(cause?.cause).toBeDefined();
      expect(result.modelFallbackAttempts?.map((a) => a.model)).toEqual([
        "fail/a",
        "fail/b",
        "fail/c",
      ]);
      expect(distinct(stub.models)).toEqual(["fail/a", "fail/b", "fail/c"]);
    } finally {
      await agent.dispose();
    }
  });

  it("never falls over on a ConfigurationError", async () => {
    const agent = await create("good/primary", ["good/one"]);
    try {
      const run = await agent.send("hello", { maxIterations: 0 });
      const result = await run.wait();
      expect(result.status).toBe("error");
      expect(result.error?.cause).toBeInstanceOf(ConfigurationError);
      expect(stub.models).toEqual([]);
    } finally {
      await agent.dispose();
    }
  });
});
