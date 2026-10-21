/**
 * A `thinking` entry in `ModelSelection.params` with an empty value must not disappear silently.
 *
 * A loop-surface-closure audit against the packed package (finding F-084ae009) saw
 * `{ id: "thinking", value: "" }` accepted by `Agent.create` and `send`, and the chat request go out
 * with neither `reasoning_effort` nor `reasoning`, while `value: "high"` sent
 * `reasoning_effort: "high"`. Nothing named the param. This file drives the same public path with
 * `globalThis.fetch` replaced by a recorder that answers the chat endpoint with a short SSE stream,
 * so the run completes without a key or a network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../src/errors.js";
import { Agent, TheokitAgentError } from "../src/index.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd("theokit-empty-thinking-");

const STUB_KEY = `sk-test-${"0".repeat(40)}`;

interface RecordedRequest {
  url: string;
  body: Record<string, unknown> | undefined;
}

function sseResponse(): Response {
  const records = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ];
  const frames = records.map((r) => `data: ${JSON.stringify(r)}\n\n`);
  const text = `${frames.join("")}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let recorded: RecordedRequest[] = [];

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

beforeEach(() => {
  recorded = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    recorded.push({
      url,
      body: raw !== undefined ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    });
    if (url.endsWith("/chat/completions")) return sseResponse();
    return new Response(JSON.stringify({ error: { message: "not stubbed" } }), { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function chatBodies(): Record<string, unknown>[] {
  return recorded
    .filter((r) => r.url.endsWith("/chat/completions") && r.body !== undefined)
    .map((r) => r.body as Record<string, unknown>);
}

async function runWithThinking(value: string): Promise<void> {
  const agent = await Agent.create({
    apiKey: STUB_KEY,
    model: { id: "o4-mini", params: [{ id: "thinking", value }] },
    providers: { routes: [{ capability: "chat", provider: "openai" }] },
    local: { cwd: process.cwd() },
  });
  try {
    const run = await agent.send("hi");
    await run.wait();
  } finally {
    await agent.dispose?.();
  }
}

describe("model.params thinking with an empty value", () => {
  it("rejects_an_empty_thinking_value_naming_the_param", async () => {
    let caught: unknown;
    try {
      await runWithThinking("");
    } catch (err) {
      caught = err;
    }
    const bodies = chatBodies();
    // A run that never reached the stub measured nothing: with no error, the request must exist.
    if (caught === undefined)
      expect(bodies, "the stub never received the chat request").toHaveLength(1);
    // The value is not forwarded in either provider shape.
    for (const body of bodies) {
      expect("reasoning" in body || "reasoning_effort" in body).toBe(false);
    }
    expect(caught, "no error was raised for thinking: ''").toBeInstanceOf(TheokitAgentError);
    expect((caught as Error).message).toContain("thinking");
  });

  it("forwards_a_non_empty_thinking_value_as_reasoning_effort", async () => {
    await runWithThinking("high");
    const bodies = chatBodies();
    expect(bodies, "the stub never received the chat request").toHaveLength(1);
    expect(bodies[0]?.reasoning_effort).toBe("high");
  });
  it("create_rejects_an_empty_thinking_value_before_any_request", async () => {
    let caught: unknown;
    try {
      await Agent.create({
        apiKey: STUB_KEY,
        model: { id: "o4-mini", params: [{ id: "thinking", value: "" }] },
        providers: { routes: [{ capability: "chat", provider: "openai" }] },
        local: { cwd: process.cwd() },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught, "Agent.create resolved with thinking: ''").toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).code).toBe("invalid_model_param");
    expect((caught as Error).message).toContain("thinking");
    expect((caught as Error).message).toContain("leave the param out");
    expect(recorded, "a request left the process before the refusal").toHaveLength(0);
  });

  it("rejects_an_empty_thinking_value_in_a_send_override", async () => {
    const agent = await Agent.create({
      apiKey: STUB_KEY,
      model: { id: "o4-mini", params: [{ id: "thinking", value: "high" }] },
      providers: { routes: [{ capability: "chat", provider: "openai" }] },
      local: { cwd: process.cwd() },
    });
    try {
      const before = recorded.length;
      let caught: unknown;
      try {
        const run = await agent.send("hi", {
          model: { id: "o4-mini", params: [{ id: "thinking", value: " " }] },
        });
        await run.wait();
      } catch (err) {
        caught = err;
      }
      expect(caught, "send resolved with thinking: ' '").toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).code).toBe("invalid_model_param");
      expect((caught as Error).message).toContain("thinking");
      expect(recorded, "a request left the process for the refused send").toHaveLength(before);
    } finally {
      await agent.dispose?.();
    }
  });
});
