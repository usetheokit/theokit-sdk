import { afterEach, describe, expect, it } from "vitest";
import { buildRunToolCatalogInput } from "../src/internal/local-agent/real-local-run-tools.js";
import {
  _resetReasoningWarnForTests,
  createThinkTool,
  isNativeReasoning,
  REASONING_PREAMBLE,
  reasoningActive,
} from "../src/internal/runtime/system-prompt/native-reasoning.js";
import { SystemPromptPipeline } from "../src/internal/runtime/system-prompt/pipeline.js";
import { ReasoningPromptProvider } from "../src/internal/runtime/system-prompt/sources/reasoning-provider.js";
import type { SystemPromptAssemblyContext } from "../src/internal/runtime/system-prompt/types.js";
import type { AgentOptions } from "../src/types/agent.js";

const baseCtx = { memory: [] } as unknown as SystemPromptAssemblyContext;

afterEach(() => _resetReasoningWarnForTests());

describe("SE37 — internal think tool (auto-attached by reasoning: true)", () => {
  it("is named think and echoes the thought (no-side-effect scratchpad)", async () => {
    const think = createThinkTool();
    expect(think.name).toBe("think");
    const out = await think.handler({ thought: "compare 9.11 and 9.9 by magnitude" });
    expect(out).toBe("compare 9.11 and 9.9 by magnitude");
  });

  it("rejects an empty thought (fail-loud at the handler boundary)", async () => {
    await expect(createThinkTool().handler({ thought: "" })).rejects.toThrow(/thought/i);
  });
});

describe("SE37 — double-reasoning guard", () => {
  it("a bare-string / no-param model is NOT native reasoning", () => {
    expect(isNativeReasoning("openai/gpt-4o-mini")).toBe(false);
    expect(isNativeReasoning(undefined)).toBe(false);
    expect(isNativeReasoning({ id: "openai/gpt-4o-mini" })).toBe(false);
  });

  it("a model with a thinking param IS native reasoning", () => {
    expect(isNativeReasoning({ id: "x", params: [{ id: "thinking", value: "high" }] })).toBe(true);
  });

  it("a param id the request builder does not forward is NOT native reasoning", () => {
    for (const id of ["reasoning", "reasoning_effort"]) {
      expect(isNativeReasoning({ id: "x", params: [{ id, value: "high" }] }), id).toBe(false);
    }
  });

  it("reasoningActive is true only when on AND the model is not native", () => {
    expect(reasoningActive(true, { id: "openai/gpt-4o-mini" })).toBe(true);
    expect(reasoningActive(false, { id: "openai/gpt-4o-mini" })).toBe(false);
    expect(reasoningActive(undefined, { id: "openai/gpt-4o-mini" })).toBe(false);
  });

  it("reasoningActive suppresses (returns false) when the model reasons natively", () => {
    expect(reasoningActive(true, { id: "x", params: [{ id: "thinking", value: "high" }] })).toBe(
      false,
    );
  });
});

describe("SE37 — reasoning preamble provider", () => {
  it("contributes the preamble when ctx.reasoning is true", async () => {
    const out = await new ReasoningPromptProvider().contribute({ ...baseCtx, reasoning: true });
    expect(out).toBe(REASONING_PREAMBLE);
  });

  it("contributes nothing when reasoning is off (byte-identical prompt)", async () => {
    const provider = new ReasoningPromptProvider();
    expect(await provider.contribute(baseCtx)).toBeUndefined();
    expect(await provider.contribute({ ...baseCtx, reasoning: false })).toBeUndefined();
  });

  it("is registered first in the default pipeline (preamble leads the prompt)", async () => {
    const pipeline = SystemPromptPipeline.default();
    expect(pipeline.providers[0]?.id).toBe("reasoning");
    const assembled = await pipeline.assemble({
      ...baseCtx,
      reasoning: true,
      baseSystemPrompt: "You are a bot.",
    });
    expect(assembled).toMatch(/^Think step by step/);
    expect(assembled).toContain("You are a bot.");
  });

  it("assembles byte-identically to baseline when reasoning is off", async () => {
    const pipeline = SystemPromptPipeline.default();
    const off = await pipeline.assemble({ ...baseCtx, baseSystemPrompt: "You are a bot." });
    expect(off).toBe("You are a bot.");
  });
});

describe("SE37 — tool-attach guard uses the EFFECTIVE (per-send override) model", () => {
  const opts = { reasoning: true, model: { id: "openai/gpt-4o-mini" } } as AgentOptions;
  const toolNames = (r: { customTools?: ReadonlyArray<{ name: string }> }) =>
    (r.customTools ?? []).map((t) => t.name);

  /**
   * Everything the two cases hold FIXED. It used to be four bare `undefined` in a row between
   * `opts` and the model — the transposition hazard the options record removed.
   */
  const BASE = {
    agentOptions: opts,
    sendOptions: undefined,
    pluginManager: undefined,
    personalityToolWhitelist: undefined,
    agentId: "a",
    personalityName: undefined,
    subagents: undefined,
  } as const;

  it("does NOT attach `think` when the effective model reasons natively (matches preamble path)", () => {
    // create-time model is non-native, but the per-send override IS native → both paths must suppress.
    const nativeOverride = { id: "x", params: [{ id: "thinking", value: "high" }] };
    const r = buildRunToolCatalogInput({ ...BASE, effectiveModel: nativeOverride });
    expect(toolNames(r)).not.toContain("think");
  });

  it("attaches `think` when the effective model is non-native", () => {
    const r = buildRunToolCatalogInput({
      ...BASE,
      effectiveModel: { id: "openai/gpt-4o-mini" },
    });
    expect(toolNames(r)).toContain("think");
  });
});
