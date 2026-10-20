/**
 * B-412 — Anthropic cache counters that arrive in `message_start`.
 *
 * Anthropic reports the cache counters of a streamed response in `message_start`, under
 * `message.usage`; the closing `message_delta` usually carries only `output_tokens`. The stream
 * loop skipped `message_start` entirely (`anthropic.ts`, the `continue` on that event), so a turn
 * that read the cache reported no read at all. The tests drive `AnthropicClient.stream` through an
 * injected `fetch`, because the skip is in the loop: calling the accumulator directly would pass
 * with the skip still in place.
 *
 * The non-streaming parser shared by the Bedrock and Vertex Anthropic clients
 * (`consumeAnthropicResponse`) returned input and output tokens only, and drops the same counters.
 */

import { describe, expect, it } from "vitest";

import { AnthropicClient } from "../../../src/internal/llm/anthropic.js";
import { consumeAnthropicResponse } from "../../../src/internal/llm/anthropic-shared.js";
import type { LlmFinish } from "../../../src/internal/llm/types.js";

function sseStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function frames(
  startUsage: Record<string, number | null>,
  deltaUsage: Record<string, number | null>,
): string[] {
  return [
    frame("message_start", {
      message: { id: "msg_1", type: "message", role: "assistant", usage: startUsage },
    }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: deltaUsage }),
    frame("message_stop", {}),
  ];
}

async function finishOf(sse: string[]): Promise<LlmFinish> {
  const stubFetch: typeof fetch = async () => sseStream(sse);
  const client = new AnthropicClient({ apiKey: "sk-test", fetch: stubFetch });
  const generator = client.stream(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    },
    new AbortController().signal,
  );
  while (true) {
    const next = await generator.next();
    if (next.done === true) return next.value;
  }
}

describe("Anthropic streaming usage read from message_start", () => {
  it("2048 read and 512 written tokens in message_start alone reach the finish", async () => {
    const u = await finishOf(
      frames(
        { input_tokens: 10, cache_read_input_tokens: 2048, cache_creation_input_tokens: 512 },
        { output_tokens: 5 },
      ),
    );
    expect(u.cacheReadTokens).toBe(2048);
    expect(u.cacheWriteTokens).toBe(512);
  });

  it("a message_delta value wins over message_start", async () => {
    const u = await finishOf(
      frames(
        { input_tokens: 10, cache_read_input_tokens: 2048 },
        { output_tokens: 5, cache_read_input_tokens: 4096 },
      ),
    );
    expect(u.cacheReadTokens).toBe(4096);
  });

  it("a zero in message_delta keeps the message_start value", async () => {
    const u = await finishOf(
      frames(
        { input_tokens: 10, cache_read_input_tokens: 2048 },
        { output_tokens: 5, cache_read_input_tokens: 0 },
      ),
    );
    expect(u.cacheReadTokens).toBe(2048);
  });

  it("a zero in message_delta keeps the message_start write count", async () => {
    const u = await finishOf(
      frames(
        { input_tokens: 10, cache_creation_input_tokens: 512 },
        { output_tokens: 5, cache_creation_input_tokens: 0 },
      ),
    );
    expect(u.cacheWriteTokens).toBe(512);
  });

  it("a null counter in message_delta keeps the message_start value", async () => {
    const u = await finishOf(
      frames(
        { input_tokens: 10, cache_read_input_tokens: 2048 },
        { output_tokens: 5, cache_read_input_tokens: null },
      ),
    );
    expect(u.cacheReadTokens).toBe(2048);
  });

  it("a message_start without cache fields reports none (EC-3)", async () => {
    const u = await finishOf(frames({ input_tokens: 10 }, { output_tokens: 5 }));
    expect(u.cacheReadTokens).toBeUndefined();
    expect(u.cacheWriteTokens).toBeUndefined();
  });
});

describe("Anthropic non-streaming parser", () => {
  it("the shared non-streaming parser keeps cache counters", async () => {
    const response = new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2048,
          cache_creation_input_tokens: 512,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    // Read through a type that names the counters: the parser's declared return type does not
    // carry them before the change, and naming them here keeps the file compiling either way.
    const r: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } =
      await consumeAnthropicResponse(response);
    expect(r.cacheReadTokens).toBe(2048);
    expect(r.cacheWriteTokens).toBe(512);
  });
});
