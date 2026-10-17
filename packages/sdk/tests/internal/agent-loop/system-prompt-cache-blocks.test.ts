/**
 * B-412 — prompt caching for the Anthropic family.
 *
 * Anthropic caches a prompt prefix only when a block carries `cache_control`, and the loop used to
 * send `system` as one string with the `<active-memory>` block prepended. So an Anthropic-family
 * model never cached the system prompt, and any memory change sat in front of it.
 *
 * `buildLoopSystem` decides the shape by model family (plan D1) and puts the configured prompt
 * first, cacheable, with the memory block after it (plan D2). Every other model keeps the string
 * `resolveSystemPromptWithMemoryAdditions` produces, so its request body does not change (NFR-001).
 *
 * The builder is read off the module namespace rather than imported by name: it does not exist
 * before the change, and a named import of a missing export fails `tsc --noEmit`, which the
 * repository's pre-commit hook runs over `tests/**`. Read this way, the file compiles today and
 * every family case fails because the builder is absent.
 */

import { describe, expect, it } from "vitest";

import * as loopLlmStream from "../../../src/internal/agent-loop/loop-llm-stream.js";
import type { LlmSystemBlock } from "../../../src/internal/llm/types.js";

type BuildLoopSystem = (
  systemPrompt?: string,
  additions?: string,
  modelId?: string,
) => string | LlmSystemBlock[] | undefined;

function buildLoopSystem(
  systemPrompt?: string,
  additions?: string,
  modelId?: string,
): string | LlmSystemBlock[] | undefined {
  const builder = (loopLlmStream as unknown as { buildLoopSystem?: BuildLoopSystem })
    .buildLoopSystem;
  if (builder === undefined) {
    throw new Error("loop-llm-stream.ts does not export buildLoopSystem");
  }
  return builder(systemPrompt, additions, modelId);
}

function asBlocks(system: string | LlmSystemBlock[] | undefined): LlmSystemBlock[] {
  if (!Array.isArray(system)) {
    throw new Error(`expected system blocks, got ${JSON.stringify(system)}`);
  }
  return system;
}

const { resolveSystemPromptWithMemoryAdditions } = loopLlmStream;

const FAMILY_IDS = [
  "openrouter/anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4.5",
  "claude-sonnet-4-6",
];
const OTHER_IDS = ["openai/gpt-4o-mini", "google/gemini-2.5-flash-lite"];

describe("buildLoopSystem — system blocks for the Anthropic family", () => {
  it("an Anthropic-family id gets the configured prompt as block 1, cacheable", () => {
    for (const id of FAMILY_IDS) {
      const s = asBlocks(buildLoopSystem("You are X", "fact", id));
      expect(s[0], id).toEqual({ text: "You are X", cacheable: true });
    }
  });

  it("the memory block is block 2, unmarked", () => {
    for (const id of FAMILY_IDS) {
      const s = asBlocks(buildLoopSystem("You are X", "fact", id));
      expect(s[1], id).toEqual({ text: "<active-memory>\nfact\n</active-memory>" });
    }
  });

  it("block 1 is identical across two different memory additions", () => {
    const a = asBlocks(buildLoopSystem("You are X", "fact A", "anthropic/claude-haiku-4.5"));
    const b = asBlocks(buildLoopSystem("You are X", "fact B", "anthropic/claude-haiku-4.5"));
    expect(a[0]).toEqual(b[0]);
  });

  it("a model outside the Anthropic family keeps the string", () => {
    for (const id of OTHER_IDS) {
      const s = buildLoopSystem("You are X", "fact", id);
      const r = resolveSystemPromptWithMemoryAdditions("You are X", "fact");
      expect(s, id).toEqual(r);
    }
  });

  it("an empty configured prompt sends the memory string (EC-1)", () => {
    const s = buildLoopSystem("", "fact", "anthropic/claude-haiku-4.5");
    const r = resolveSystemPromptWithMemoryAdditions("", "fact");
    expect(s).toEqual(r);
  });

  it("a prompt with no memory is one cacheable block (EC-2)", () => {
    const s = buildLoopSystem("You are X", undefined, "anthropic/claude-haiku-4.5");
    expect(s).toEqual([{ text: "You are X", cacheable: true }]);
  });
});
