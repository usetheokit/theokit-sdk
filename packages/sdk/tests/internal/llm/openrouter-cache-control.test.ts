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
 *
 * The encoder module is loaded by a computed specifier: it does not exist before the change, and
 * a literal import of a missing module fails `tsc --noEmit`, which the pre-commit hook runs over
 * `tests/**`. Loaded this way the file compiles today and the encoder case fails at import.
 */

import { describe, expect, it } from "vitest";

import { collapseSystemText } from "../../../src/internal/llm/finish.js";
import { __testing__buildOpenAIBody } from "../../../src/internal/llm/openai.js";
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

type EncodeOpenRouterSystemContent = (
  system: LlmRequest["system"],
) => Array<Record<string, unknown>> | undefined;

async function loadEncoder(): Promise<EncodeOpenRouterSystemContent> {
  const specifier = "../../../src/internal/llm/openrouter-system.js";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    encodeOpenRouterSystemContent?: EncodeOpenRouterSystemContent;
  };
  if (mod.encodeOpenRouterSystemContent === undefined) {
    throw new Error("openrouter-system.ts does not export encodeOpenRouterSystemContent");
  }
  return mod.encodeOpenRouterSystemContent;
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

  it("the encoder returns undefined when no block is cacheable", async () => {
    const enc = await loadEncoder();
    const out = enc([{ text: configured }, { text: memory }]);
    expect(out).toBeUndefined();
  });
});
