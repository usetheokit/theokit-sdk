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
 */

import { describe, expect, it } from "vitest";

import {
  buildLoopSystem,
  resolveSystemPromptWithMemoryAdditions,
} from "../../../src/internal/agent-loop/loop-llm-stream.js";
import type { LlmSystemBlock } from "../../../src/internal/llm/types.js";

function asBlocks(system: string | LlmSystemBlock[] | undefined): LlmSystemBlock[] {
  if (!Array.isArray(system)) {
    throw new Error(`expected system blocks, got ${JSON.stringify(system)}`);
  }
  return system;
}

const FAMILY_IDS = [
  "openrouter/anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4.5",
  "claude-sonnet-4-6",
];
// A Bedrock id (`anthropic.claude-…`) is outside the family on purpose, and so is a missing id.
const OTHER_IDS = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash-lite",
  "anthropic.claude-3-5-sonnet-20241022-v2:0",
  undefined,
];

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
