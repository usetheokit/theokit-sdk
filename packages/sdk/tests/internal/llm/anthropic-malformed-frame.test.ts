/**
 * An Anthropic SSE frame whose data is not JSON is never dropped without a trace.
 *
 * The stream loop used to `continue` past a frame `JSON.parse` refused. Since `message_start` is
 * read for the cache and input counters, a malformed one lost them silently; a malformed
 * `content_block_delta` lost text or tool input and the turn still ended as `end_turn`.
 *
 * A frame that carries content or the stop reason fails the turn with a typed, retryable
 * `NetworkError` (`stream_malformed_frame`): finishing with a hole in the answer is worse than a
 * retry. Any other frame is reported on the diagnostics channel and the turn continues.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworkError } from "../../../src/errors.js";
import { AnthropicClient } from "../../../src/internal/llm/anthropic.js";
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

function malformed(event: string): string {
  return `event: ${event}\ndata: not json\n\n`;
}

/** A broken frame whose body carries text a caller could not want copied into a span or a log. */
const SECRET_MARKER = "sk-live-do-not-export-4f1c9e";
const secretBody = `{"type":"content_block_delta","delta":{"text":"${SECRET_MARKER}"`;

function malformedWith(event: string, body: string): string {
  return `event: ${event}\ndata: ${body}\n\n`;
}

function captureStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

const start = frame("message_start", {
  message: { id: "msg_1", type: "message", role: "assistant", usage: { input_tokens: 10 } },
});
const text = frame("content_block_delta", {
  index: 0,
  delta: { type: "text_delta", text: "Hello" },
});
const end = frame("message_delta", {
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 5 },
});

async function finishOf(sse: string[]): Promise<LlmFinish> {
  const client = new AnthropicClient({ apiKey: "sk-test", fetch: async () => sseStream(sse) });
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Anthropic SSE frames that are not JSON", () => {
  it("a malformed content_block_delta fails the turn with stream_malformed_frame", async () => {
    const run = finishOf([start, text, malformed("content_block_delta"), end]);
    await expect(run).rejects.toBeInstanceOf(NetworkError);
    await expect(finishOf([start, malformed("content_block_delta"), end])).rejects.toMatchObject({
      code: "stream_malformed_frame",
    });
  });

  it("a malformed message_delta fails the turn with stream_malformed_frame", async () => {
    await expect(finishOf([start, text, malformed("message_delta")])).rejects.toMatchObject({
      code: "stream_malformed_frame",
    });
  });

  it("a malformed message_start is reported on the diagnostics channel", async () => {
    const writes = captureStderr();
    const finish = await finishOf([malformed("message_start"), text, end]);
    expect(finish.text).toBe("Hello");
    expect(writes.some((w) => w.includes("message_start") && w.includes("8 chars"))).toBe(true);
  });

  it("a malformed content_block_start fails the turn with stream_malformed_frame", async () => {
    await expect(
      finishOf([start, malformed("content_block_start"), text, end]),
    ).rejects.toMatchObject({ code: "stream_malformed_frame" });
  });

  it("the error for a malformed content frame names the event and length, not the body", async () => {
    const error = await finishOf([
      start,
      malformedWith("content_block_delta", secretBody),
      end,
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkError);
    const message = (error as NetworkError).message;
    expect(message).toContain("content_block_delta");
    expect(message).toContain(`${secretBody.length} chars`);
    expect(message).not.toContain(SECRET_MARKER);
  });

  it("the diagnostic line for a skipped malformed frame does not copy the body", async () => {
    const writes = captureStderr();
    await finishOf([malformedWith("message_start", secretBody), text, end]);
    const line = writes.find((w) => w.includes("message_start"));
    expect(line).toContain(`${secretBody.length} chars`);
    expect(writes.join("")).not.toContain(SECRET_MARKER);
  });
});
