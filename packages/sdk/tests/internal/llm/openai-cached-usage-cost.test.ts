/**
 * A cached turn on the chat-completions wire is billed once.
 *
 * Chat Completions reports `prompt_tokens` as the whole prompt, cached slice included, and the
 * cached slice again in `prompt_tokens_details.cached_tokens` (OpenRouter adds
 * `cache_write_tokens` beside it). The SDK's usage contract is the Anthropic one: `inputTokens`
 * is the uncached portion and the cache buckets are separate (`normalize-usage.ts`). When the
 * stream client stored the gross `prompt_tokens` as `inputTokens`, `computeCost` charged the
 * cached tokens at the full input rate and again at the cache-read rate, about 8x on the turn
 * below. Turning on `cache_control` for Anthropic models on OpenRouter made that the normal case.
 */

import { describe, expect, it } from "vitest";

import { computeCost } from "../../../src/internal/budget/compute-cost.js";
import { OpenAIClient } from "../../../src/internal/llm/openai.js";
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

async function finishOf(usage: Record<string, unknown>): Promise<LlmFinish> {
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const client = new OpenAIClient({ apiKey: "sk-test", fetch: async () => sseStream(frames) });
  const generator = client.stream(
    {
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    },
    new AbortController().signal,
  );
  while (true) {
    const next = await generator.next();
    if (next.done === true) return next.value;
  }
}

function costOf(finish: LlmFinish): number | undefined {
  return computeCost({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      inputTokens: finish.inputTokens ?? 0,
      outputTokens: finish.outputTokens ?? 0,
      ...(finish.cacheReadTokens !== undefined ? { cacheReadTokens: finish.cacheReadTokens } : {}),
      ...(finish.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: finish.cacheWriteTokens }
        : {}),
      totalTokens: 0,
    },
  }).amountUsd;
}

describe("chat-completions usage keeps the cached slice out of inputTokens", () => {
  it("a cached OpenRouter turn is billed at the cache-read rate only", async () => {
    // haiku-4-5: input 1.0, output 5.0, cacheRead 0.1 per million tokens.
    // 52 uncached input + 8 output + 2048 cache read = 0.000052 + 0.00004 + 0.000205 (each bucket
    // rounded to microcents). Billing the gross 2100 as input as well gave 0.002345.
    const finish = await finishOf({
      prompt_tokens: 2100,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 2048 },
    });
    expect(finish.inputTokens).toBe(52);
    expect(finish.cacheReadTokens).toBe(2048);
    expect(costOf(finish)).toBeCloseTo(0.000297, 9);
  });

  it("OpenRouter's prompt_tokens_details.cache_write_tokens is read and subtracted", async () => {
    const finish = await finishOf({
      prompt_tokens: 3000,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2900 },
    });
    expect(finish.cacheWriteTokens).toBe(2900);
    expect(finish.inputTokens).toBe(100);
  });

  it("the top-level Anthropic-style cache fields are subtracted too", async () => {
    const finish = await finishOf({
      prompt_tokens: 5000,
      completion_tokens: 200,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 1000,
    });
    expect(finish.inputTokens).toBe(1000);
  });

  it("the nested cache counts win over a top-level zero, as normalizeUsage reads them", async () => {
    const finish = await finishOf({
      prompt_tokens: 2100,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 40 },
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(finish.cacheReadTokens).toBe(2048);
    expect(finish.cacheWriteTokens).toBe(40);
    expect(finish.inputTokens).toBe(12);
  });

  it("a top-level count fills a nested zero", async () => {
    const finish = await finishOf({
      prompt_tokens: 3000,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 0 },
      cache_read_input_tokens: 2500,
    });
    expect(finish.cacheReadTokens).toBe(2500);
    expect(finish.inputTokens).toBe(500);
  });

  it("cache counts above the prompt total floor inputTokens at zero", async () => {
    const finish = await finishOf({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 150 },
    });
    expect(finish.inputTokens).toBe(0);
  });

  it("a turn with no cache buckets keeps prompt_tokens as inputTokens", async () => {
    const finish = await finishOf({ prompt_tokens: 11, completion_tokens: 4 });
    expect(finish.inputTokens).toBe(11);
    expect(finish.cacheReadTokens).toBeUndefined();
  });
});
