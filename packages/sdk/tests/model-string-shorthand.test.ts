import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Agent, ConfigurationError } from "../src/index.js";
import { normalizeModel } from "../src/internal/runtime/model-selection.js";
import type { ModelSelection } from "../src/types/agent-prims.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

// This file creates agents without naming a cwd — `local: {}` and an omitted `local` both fall
// back to process.cwd(), which during a test run is the package itself, so the sessions landed
// in packages/sdk/.theokit/. See useTempCwd's docblock for the 540 MB that bought.
useTempCwd();

/**
 * SE8 — model bare-string shorthand. `AgentOptions.model` and `SendOptions.model` accept a bare string
 * id (`"openai/gpt-4o-mini"`) normalized to `{ id }` at one seam; the object form is unchanged.
 *
 * TDD RED-first.
 */

const FIXTURE_KEY = "theo_test_model_shorthand";

describe("normalizeModel (SE8) — the one boundary normalizer", () => {
  it("maps a bare string id to { id }", () => {
    expect(normalizeModel("openai/gpt-4o-mini")).toEqual({ id: "openai/gpt-4o-mini" });
  });

  it("trims surrounding whitespace on a string id", () => {
    expect(normalizeModel("  anthropic/claude-sonnet-4-6  ")).toEqual({
      id: "anthropic/claude-sonnet-4-6",
    });
  });

  it("passes a ModelSelection object through unchanged (incl. params)", () => {
    const m = { id: "x/y", params: [] as never[] };
    expect(normalizeModel(m)).toBe(m);
  });

  it("passes undefined through", () => {
    expect(normalizeModel(undefined)).toBeUndefined();
  });

  it("rejects an empty / whitespace-only string with a typed ConfigurationError", () => {
    expect(() => normalizeModel("")).toThrow(ConfigurationError);
    expect(() => normalizeModel("   ")).toThrow(ConfigurationError);
  });
});

describe("model shorthand (SE8) — Agent.create + send accept a string", () => {
  it("Agent.create({ model: '<string>' }) resolves identically to { id: '<string>' }", async () => {
    const viaString = await Agent.create({ apiKey: FIXTURE_KEY, model: "openai/gpt-4o-mini" });
    const viaObject = await Agent.create({
      apiKey: FIXTURE_KEY,
      model: { id: "openai/gpt-4o-mini" },
    });
    const r1 = await (await viaString.send("hi")).wait();
    const r2 = await (await viaObject.send("hi")).wait();
    expect(r1.model).toEqual({ id: "openai/gpt-4o-mini" });
    expect(r1.model).toEqual(r2.model);
    await viaString.dispose();
    await viaObject.dispose();
  });

  it("send({ model: '<string>' }) overrides with the normalized model", async () => {
    const agent = await Agent.create({ apiKey: FIXTURE_KEY, model: { id: "openai/gpt-4o-mini" } });
    const run = await agent.send("hi", { model: "anthropic/claude-sonnet-4-6" });
    const result = await run.wait();
    expect(result.model).toEqual({ id: "anthropic/claude-sonnet-4-6" });
    await agent.dispose();
  });

  it("a cloud send({ model: '<string>' }) override normalizes too", async () => {
    const agent = await Agent.create({
      apiKey: FIXTURE_KEY,
      model: { id: "openai/gpt-4o-mini" },
      cloud: { repos: [] },
    });
    const run = await agent.send("hi", { model: "anthropic/claude-sonnet-4-6" });
    const result = await run.wait();
    expect(result.model).toEqual({ id: "anthropic/claude-sonnet-4-6" });
    await agent.dispose();
  });

  it("Agent.create({ model: '' }) rejects at the boundary with a typed ConfigurationError", async () => {
    await expect(Agent.create({ apiKey: FIXTURE_KEY, model: "  " })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});

describe("model shorthand (SE8) — generateObject / streamObject accept a string (type-level)", () => {
  it("the option shapes accept a bare-string model (pass-through to the tested Agent.create seam)", () => {
    // Compile-time proof the widened public surfaces accept the shorthand. The
    // runtime path forwards `model` to `Agent.create`, whose normalization is
    // covered by the tests above — so a type-check here is the meaningful assertion.
    const gen: import("../src/index.js").GenerateObjectOptions<never> = {
      prompt: "x",
      model: "openai/gpt-4o-mini",
    } as never;
    const strm: import("../src/index.js").StreamObjectOptions<never> = {
      prompt: "x",
      model: "openai/gpt-4o-mini",
    } as never;
    expect(gen.model).toBe("openai/gpt-4o-mini");
    expect(strm.model).toBe("openai/gpt-4o-mini");
  });
});

describe("normalizeModel refuses a thinking param with no effort", () => {
  it("refuses_a_thinking_param_with_an_empty_value", () => {
    const refused: unknown[] = [
      [{ id: "thinking", value: "" }],
      [{ id: "thinking", value: "   " }],
      [{ id: "thinking" }],
      [{ id: "thinking", value: null }],
      [{ id: "thinking", value: 42 }],
      [
        { id: "thinking", value: "high" },
        { id: "thinking", value: "" },
      ],
    ];
    for (const params of refused) {
      const selection = { id: "o4-mini", params } as unknown as ModelSelection;
      let caught: unknown;
      try {
        normalizeModel(selection);
      } catch (err) {
        caught = err;
      }
      expect(caught, `not refused: ${JSON.stringify(params)}`).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).code).toBe("invalid_model_param");
      expect((caught as Error).message).toContain("thinking");
      expect((caught as Error).message).toContain("leave the param out");
    }
    const low = { id: "o4-mini", params: [{ id: "thinking", value: "low" }] };
    expect(normalizeModel(low)).toBe(low);
    const other = { id: "o4-mini", params: [{ id: "other", value: "" }] };
    expect(normalizeModel(other)).toBe(other);
  });
});

describe("the thinking param contract is documented where consumers read it", () => {
  const src = join(import.meta.dirname, "..", "src");

  it("documents_the_thinking_param_contract", () => {
    const prims = readFileSync(join(src, "types/agent-prims.ts"), "utf8");
    const declaration = prims.indexOf("export interface ModelParameterValue");
    const docblock = prims.slice(prims.lastIndexOf("/**", declaration), declaration);
    expect(docblock).toContain("thinking");
    expect(docblock).toContain("non-empty");
    for (const file of ["types/agent.ts", "internal/runtime/system-prompt/native-reasoning.ts"]) {
      expect(readFileSync(join(src, file), "utf8"), file).not.toContain('[{ id: "thinking" }]');
    }
  });
});
