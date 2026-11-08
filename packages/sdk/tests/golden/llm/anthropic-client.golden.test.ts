import { describe, expect, it } from "vitest";

import { AnthropicClient } from "../../../src/internal/llm/anthropic.js";

/**
 * Behaviour gate for the real Anthropic streaming client. Uses a stub
 * `fetch` that emits canned SSE frames so the test stays deterministic and
 * never hits the network.
 */

function sseStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("real Anthropic client", () => {
  it("translates SSE into text_delta events + tool_use on finish", async () => {
    const frames = [
      "event: message_start\ndata: {}\n\n",
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"shell","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":12,"output_tokens":3}}\n\n',
      "event: message_stop\ndata: {}\n\n",
    ];
    const stubFetch: typeof fetch = async () => sseStream(frames);
    const client = new AnthropicClient({ apiKey: "sk-test", fetch: stubFetch });

    const controller = new AbortController();
    const events: string[] = [];
    const generator = client.stream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "shell", description: "Run shell", inputSchema: { type: "object" } }],
      },
      controller.signal,
    );

    let result: Awaited<ReturnType<typeof client.stream>> extends AsyncGenerator<
      unknown,
      infer R,
      unknown
    >
      ? R
      : never;
    while (true) {
      const next = await generator.next();
      if (next.done === true) {
        result = next.value;
        break;
      }
      if (next.value.type === "text_delta") events.push(next.value.text);
    }
    expect(events.join("")).toBe("Hello world");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("shell");
    expect(result.toolCalls[0]?.input).toEqual({ cmd: "ls" });
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(3);
  });

  it("a malformed content frame's error and cause do not quote the frame body", async () => {
    const marker = "sk-live-secret";
    const stubFetch: typeof fetch = async () =>
      sseStream([`event: content_block_delta\ndata: ${marker}\n\n`]);
    const client = new AnthropicClient({ apiKey: "sk-test", fetch: stubFetch });
    const generator = client.stream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
      },
      new AbortController().signal,
    );
    let caught: unknown;
    try {
      while (true) if ((await generator.next()).done === true) break;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).not.toContain(marker);
    expect(err.cause).toBeDefined();
    expect(String(err.cause)).not.toContain(marker);
  });

  it("surfaces HTTP 401 as AuthenticationError with full metadata (post-D67 mapper)", async () => {
    const stubFetch: typeof fetch = async () =>
      new Response('{"error":{"type":"authentication_error","message":"bad key"}}', {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      });
    const client = new AnthropicClient({ apiKey: "bad", fetch: stubFetch });
    const controller = new AbortController();
    await expect(
      (async () => {
        const gen = client.stream(
          {
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          },
          controller.signal,
        );
        await gen.next();
      })(),
    ).rejects.toMatchObject({
      name: "AuthenticationError",
      metadata: {
        provider: "anthropic",
        endpoint: "/v1/messages",
        code: "auth_failed",
        statusCode: 401,
      },
    });
  });
});
