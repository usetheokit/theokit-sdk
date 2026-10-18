/**
 * B-412 — OpenRouter keeps the cache directive on the chat-completions wire.
 *
 * For Anthropic models OpenRouter caches a prefix when a text part of a message's `content`
 * array carries `cache_control` (https://openrouter.ai/docs/features/prompt-caching). The
 * chat-completions body used to collapse `system` to one string for every provider, so the
 * cacheable block the loop sends for an Anthropic-family model lost its directive there.
 *
 * Only OpenRouter gets content parts (plan D3); every other chat-completions provider keeps the
 * joined string, since OpenAI's own API does not document `cache_control` (FR-004).
 */

import { describe, expect, it } from "vitest";

import { collapseSystemText } from "../../../src/internal/llm/finish.js";
import { __testing__buildOpenAIBody } from "../../../src/internal/llm/openai.js";
import { encodeOpenRouterSystemContent } from "../../../src/internal/llm/openrouter-system.js";
import type { LlmRequest, LlmSystemBlock } from "../../../src/internal/llm/types.js";

const configured = "You are a careful assistant.";
const memory = "<active-memory>\nfact\n</active-memory>";

const blocks: LlmSystemBlock[] = [{ text: configured, cacheable: true }, { text: memory }];

function request(system: LlmRequest["system"]): LlmRequest {
  return {
    model: "anthropic/claude-haiku-4.5",
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
}

function systemMessage(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const messages = body.messages as Array<Record<string, unknown>>;
  return messages.find((m) => m.role === "system");
}

describe("OpenRouter system content parts with cache_control", () => {
  it("the OpenRouter body carries cache_control on the cacheable part", () => {
    const sys = systemMessage(__testing__buildOpenAIBody(request(blocks), "openrouter"));
    expect(sys).toEqual({
      role: "system",
      content: [
        { type: "text", text: configured, cache_control: { type: "ephemeral" } },
        { type: "text", text: memory },
      ],
    });
  });

  it("other providers collapse to a string", () => {
    const sys = systemMessage(__testing__buildOpenAIBody(request(blocks), "openai"));
    expect(typeof sys?.content).toBe("string");
    expect(sys?.content).toBe(collapseSystemText(blocks));
  });

  it("the encoder returns undefined when no block is cacheable", () => {
    const out = encodeOpenRouterSystemContent([{ text: configured }, { text: memory }]);
    expect(out).toBeUndefined();
  });
});
