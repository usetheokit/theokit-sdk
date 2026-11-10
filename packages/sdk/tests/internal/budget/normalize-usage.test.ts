/**
 * Phase 3 (T3.1) — normalizeUsage 3 API shapes + a peer#10266 regression.
 */

import { describe, expect, it } from "vitest";

import { inferApiMode, normalizeUsage } from "../../../src/internal/budget/normalize-usage.js";

describe("normalizeUsage — Anthropic Messages 4-bucket", () => {
  it("input + output + cache_read + cache_creation kept separate", () => {
    const raw = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 400,
    };
    const u = normalizeUsage(raw, { provider: "anthropic", apiMode: "anthropic_messages" });
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(500);
    expect(u.cacheReadTokens).toBe(2000);
    expect(u.cacheWriteTokens).toBe(400);
    expect(u.totalTokens).toBe(1000 + 500 + 2000 + 400);
  });

  it("missing cache fields default to undefined (not 0) in returned shape", () => {
    const raw = { input_tokens: 100, output_tokens: 50 };
    const u = normalizeUsage(raw, { provider: "anthropic" });
    expect(u.cacheReadTokens).toBeUndefined();
    expect(u.cacheWriteTokens).toBeUndefined();
  });
});

describe("normalizeUsage — OpenAI Chat Completions subtracts cached_tokens", () => {
  it("prompt_tokens INCLUDES cached → inputTokens is the non-cached remainder", () => {
    const raw = {
      prompt_tokens: 3000,
      completion_tokens: 700,
      prompt_tokens_details: { cached_tokens: 1800 },
    };
    const u = normalizeUsage(raw, { provider: "openai", apiMode: "openai_chat_completions" });
    expect(u.inputTokens).toBe(1200);
    expect(u.cacheReadTokens).toBe(1800);
    expect(u.outputTokens).toBe(700);
  });

  it("EC: a peer#10266 — proxy expose Anthropic-style top-level fields routing Claude", () => {
    const raw = {
      prompt_tokens: 5000,
      completion_tokens: 200,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 1000,
    };
    const u = normalizeUsage(raw, { provider: "openrouter", apiMode: "openai_chat_completions" });
    expect(u.cacheReadTokens).toBe(3000);
    expect(u.cacheWriteTokens).toBe(1000);
    expect(u.inputTokens).toBe(1000);
  });

  it("reasoning_tokens read from completion_tokens_details", () => {
    const raw = {
      prompt_tokens: 100,
      completion_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 50 },
    };
    const u = normalizeUsage(raw, { provider: "openai" });
    expect(u.reasoningTokens).toBe(50);
  });
});

describe("normalizeUsage — OpenAI Responses (Codex)", () => {
  it("input_tokens INCLUDES cached + creation; subtract both", () => {
    const raw = {
      input_tokens: 4000,
      output_tokens: 800,
      input_tokens_details: { cached_tokens: 2000, cache_creation_tokens: 500 },
      output_tokens_details: { reasoning_tokens: 100 },
    };
    const u = normalizeUsage(raw, { provider: "openai-codex", apiMode: "openai_responses" });
    expect(u.inputTokens).toBe(1500);
    expect(u.cacheReadTokens).toBe(2000);
    expect(u.cacheWriteTokens).toBe(500);
    expect(u.reasoningTokens).toBe(100);
  });
});

describe("normalizeUsage — defensive against bad input", () => {
  it("null/undefined returns zero buckets", () => {
    const u1 = normalizeUsage(null, { provider: "openai" });
    expect(u1.inputTokens).toBe(0);
    expect(u1.outputTokens).toBe(0);
    expect(u1.totalTokens).toBe(0);
    const u2 = normalizeUsage(undefined, { provider: "openai" });
    expect(u2.totalTokens).toBe(0);
  });

  it("non-object (string, number) returns zero buckets", () => {
    expect(normalizeUsage("foo", { provider: "openai" }).totalTokens).toBe(0);
    expect(normalizeUsage(42, { provider: "openai" }).totalTokens).toBe(0);
  });

  it("string token counts coerced via parseInt", () => {
    const raw = { prompt_tokens: "1000", completion_tokens: "500" };
    const u = normalizeUsage(raw, { provider: "openai" });
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(500);
  });

  it("negative token counts clamped to 0", () => {
    const raw = { prompt_tokens: -50, completion_tokens: -1 };
    const u = normalizeUsage(raw, { provider: "openai" });
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
  });

  it("missing prompt_tokens_details survives (no crash)", () => {
    const raw = { prompt_tokens: 100, completion_tokens: 50 };
    const u = normalizeUsage(raw, { provider: "openai" });
    expect(u.cacheReadTokens).toBeUndefined();
  });
});

describe("inferApiMode", () => {
  it("anthropic → anthropic_messages", () => {
    expect(inferApiMode("anthropic")).toBe("anthropic_messages");
    expect(inferApiMode("claude")).toBe("anthropic_messages");
  });

  it("openai-codex / codex → openai_responses", () => {
    expect(inferApiMode("openai-codex")).toBe("openai_responses");
    expect(inferApiMode("codex")).toBe("openai_responses");
  });

  it("openai / openrouter / unknown → openai_chat_completions fallback", () => {
    expect(inferApiMode("openai")).toBe("openai_chat_completions");
    expect(inferApiMode("openrouter")).toBe("openai_chat_completions");
    expect(inferApiMode("totally-unknown")).toBe("openai_chat_completions");
  });
});

describe("normalizeUsage — unusable nested cache count (#934)", () => {
  it("falls back to the top-level cache_read_input_tokens", () => {
    const u = normalizeUsage(
      {
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: -1 },
        cache_read_input_tokens: 4,
      },
      { provider: "openai", apiMode: "openai_chat_completions" },
    );
    expect(u.cacheReadTokens).toBe(4);
    expect(u.inputTokens).toBe(6);
  });
});
