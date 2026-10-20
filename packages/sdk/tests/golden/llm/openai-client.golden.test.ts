import { describe, expect, it } from "vitest";

import { OpenAIClient } from "../../../src/internal/llm/openai.js";

/**
 * Behaviour gate for the real OpenAI Chat Completions streaming client.
 * Uses a stub `fetch` that emits canned SSE frames.
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

describe("real OpenAI client", () => {
  it("translates content/tool_calls deltas into provider-agnostic events", async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
    ];
    const stubFetch: typeof fetch = async () => sseStream(frames);
    const client = new OpenAIClient({ apiKey: "sk-test", fetch: stubFetch });

    const controller = new AbortController();
    const texts: string[] = [];
    const generator = client.stream(
      {
        model: "gpt-4o-mini",
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
      if (next.value.type === "text_delta") texts.push(next.value.text);
    }
    expect(texts.join("")).toBe("Hello world");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("shell");
    expect(result.toolCalls[0]?.input).toEqual({ cmd: "ls" });
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(4);
  });

  it("parses 5-bucket usage from OpenAI/OpenRouter extended fields (D376)", async () => {
    // Final usage chunk shape when `stream_options.include_usage: true` is set:
    // last chunk has empty choices + populated usage with `prompt_tokens_details`
    // (cached_tokens) and `completion_tokens_details` (reasoning_tokens).
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
      "data: [DONE]\n\n",
    ];
    const stubFetch: typeof fetch = async () => sseStream(frames);
    const client = new OpenAIClient({ apiKey: "sk-test", fetch: stubFetch });
    const generator = client.stream(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      },
      new AbortController().signal,
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
    }
    // prompt_tokens 120 includes the 80 cached tokens; inputTokens is the uncached 40.
    expect(result.inputTokens).toBe(40);
    expect(result.outputTokens).toBe(8);
    expect(result.cacheReadTokens).toBe(80);
    expect(result.reasoningTokens).toBe(3);
  });

  it("parses Anthropic-on-OpenRouter top-level cache fields (a peer#10266)", async () => {
    // Anthropic models accessed via OpenRouter sometimes expose
    // cache_creation_input_tokens / cache_read_input_tokens at the top level
    // of `usage` (proxied through the Anthropic Messages shape).
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5000,"completion_tokens":200,"cache_read_input_tokens":3000,"cache_creation_input_tokens":1000}}\n\n',
      "data: [DONE]\n\n",
    ];
    const client = new OpenAIClient({
      apiKey: "sk-test",
      fetch: async () => sseStream(frames),
    });
    const generator = client.stream(
      {
        model: "anthropic/claude-opus-4-7",
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      },
      new AbortController().signal,
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
    }
    expect(result.cacheReadTokens).toBe(3000);
    expect(result.cacheWriteTokens).toBe(1000);
  });
});
