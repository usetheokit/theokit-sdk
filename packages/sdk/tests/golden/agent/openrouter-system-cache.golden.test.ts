/**
 * B-475 — an Anthropic model on OpenRouter gets the cacheable system block on the wire, end to end.
 *
 * Each link has its own test: the loop's family check (`system-prompt-cache-blocks.test.ts`) and
 * the OpenRouter encoder through a hand-passed provider name (`openrouter-cache-control.test.ts`).
 * Nothing drove them together: `Agent.send` with an `openrouter/anthropic/…` id resolving the
 * router's `openrouter` profile, whose name is what selects content parts in `OpenAIClient`. This
 * file runs that path against a local chat-completions endpoint and reads the captured body.
 */

import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../../src/index.js";
import { useTempCwd } from "../../helpers/temp-workspace.js";

interface Captured {
  body: Record<string, unknown> | undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    req.on("end", () => resolve(buf));
  });
}

async function startStubOpenRouter(): Promise<{ server: Server; url: string; captured: Captured }> {
  const captured: Captured = { body: undefined };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url?.endsWith("/chat/completions") !== true) {
      res.statusCode = 404;
      res.end();
      return;
    }
    captured.body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.write(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    );
    res.write('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":1}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
  return { server, url: `http://127.0.0.1:${addr.port}`, captured };
}

useTempCwd("theokit-openrouter-cache-");

describe("OpenRouter Anthropic system prompt on the wire", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((r) => server?.close(() => r()));
      server = undefined;
    }
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_BASE_URL;
  });

  async function sendThrough(modelId: string): Promise<Record<string, unknown> | undefined> {
    const stub = await startStubOpenRouter();
    server = stub.server;
    process.env.OPENROUTER_API_KEY = "sk-or-stub-0000000000";
    process.env.OPENROUTER_API_BASE_URL = stub.url;
    const agent = await Agent.create({
      apiKey: "sk-or-stub-0000000000",
      model: { id: modelId },
      systemPrompt: "Be terse.",
      local: { cwd: process.cwd() },
    });
    await (await agent.send("hi")).wait();
    return stub.captured.body;
  }

  function systemMessage(body: Record<string, unknown> | undefined): Record<string, unknown> {
    const messages = (body?.messages ?? []) as Array<Record<string, unknown>>;
    const system = messages.find((m) => m.role === "system");
    if (system === undefined) throw new Error(`no system message in ${JSON.stringify(body)}`);
    return system;
  }

  it("an openrouter/anthropic model sends the prompt as a part carrying cache_control", async () => {
    const body = await sendThrough("openrouter/anthropic/claude-haiku-4.5");
    const content = systemMessage(body).content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]?.text).toBe("Be terse.");
    expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("a non-Anthropic model on OpenRouter keeps the system prompt as one string", async () => {
    const body = await sendThrough("openrouter/openai/gpt-4o-mini");
    expect(systemMessage(body).content).toBe("Be terse.");
  });
});
