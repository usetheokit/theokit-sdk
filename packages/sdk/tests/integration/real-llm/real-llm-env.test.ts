import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../../src/index.js";
import { useTempCwd } from "../../helpers/temp-workspace.js";
import { resolveRealLlmEnv } from "./_helpers/real-llm-env.js";

/**
 * The gate that decides whether the real-LLM matrix runs at all.
 *
 * Twenty-two test files call `resolveRealLlmEnv` and pass its `shouldSkip` to `describe.skipIf`.
 * Nothing tested the helper itself, which is the same hole `ollama-probe.test.ts` exists to close
 * one directory over: a gate whose failure direction is "skip" disappears silently. If this
 * function ever returned `shouldSkip: true` unconditionally — a typo, a refactor, an inverted
 * boolean — all twenty-two files would stop running, every suite would stay GREEN, and the only
 * visible trace would be a skipped count nobody reads.
 *
 * So the assertions that matter most here are the ones proving it DOES open (`testing.md` § 4.2):
 * a guard tested only on the inputs it rejects cannot tell a correct predicate from one that
 * rejects everything.
 */

const VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    const previous = saved[v];
    if (previous === undefined) delete process.env[v];
    else process.env[v] = previous;
  }
});

describe("the gate opens", () => {
  it("runs against the provider's own key when it is set", () => {
    process.env.OPENAI_API_KEY = "sk-test-key";

    const handle = resolveRealLlmEnv("openai");

    expect(handle.shouldSkip).toBe(false);
    expect(handle.provider).toBe("openai");
    expect(handle.apiKey).toBe("sk-test-key");
    expect(handle.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("falls back to OpenRouter when the provider's own key is absent", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const handle = resolveRealLlmEnv("anthropic");

    expect(handle.shouldSkip).toBe(false);
    expect(handle.provider).toBe("openrouter");
    expect(handle.apiKey).toBe("sk-or-test");
    // The MODEL still comes from the provider asked for — the fallback changes routing, not intent.
    // The `openrouter/` prefix carries the routing (#719).
    expect(handle.model).toBe("openrouter/anthropic/claude-haiku-4.5");
  });

  it("honours an explicit model override", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    expect(resolveRealLlmEnv("openrouter", { model: "meta/llama-3.1-8b" }).model).toBe(
      "meta/llama-3.1-8b",
    );
  });
});

describe("the OpenRouter fallback routes where it says it does", () => {
  // Agent.create persists state under process.cwd(); keep it out of the package.
  useTempCwd();

  // A shape-valid OpenRouter key. Agent.create checks the key's shape and makes no request,
  // so nothing here reaches a model.
  const FAKE_OPENROUTER_KEY = "sk-or-v1-0000000000000000000000000000";

  it("hands back a model and key that Agent.create accepts for the provider it fell back from", async () => {
    // #719: with only OPENROUTER_API_KEY set, the handle said `provider: "openrouter"` but its model
    // was `anthropic/...`, so Agent.create checked the OpenRouter key against the native Anthropic
    // provider and threw malformed_api_key in every anthropic-* suite.
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;
    const handle = resolveRealLlmEnv("anthropic");
    expect(handle.provider).toBe("openrouter");

    const agent = await Agent.create({ apiKey: handle.apiKey, model: { id: handle.model } });
    await agent.dispose();
  });

  it("names OpenRouter in the model id, so the route does not depend on the key's prefix", () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;

    expect(resolveRealLlmEnv("anthropic").model).toBe("openrouter/anthropic/claude-haiku-4.5");
    expect(resolveRealLlmEnv("openai").model).toBe("openrouter/openai/gpt-4o-mini");
  });
});

describe("the gate closes", () => {
  it("skips when nothing is configured, and says which variables it looked for", () => {
    const handle = resolveRealLlmEnv("openai");

    expect(handle.shouldSkip).toBe(true);
    expect(handle.skipReason).toContain("OPENAI_API_KEY");
    expect(handle.skipReason).toContain("OPENROUTER_API_KEY");
    expect(handle.apiKey).toBe("");
  });

  it("refuses the OpenRouter fallback for a native-only scenario", () => {
    // A native-capability test routed through OpenRouter would assert a provider feature against a
    // proxy — it would pass or fail for the wrong reason, which is worse than not running.
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const handle = resolveRealLlmEnv("anthropic", { nativeOnly: true });

    expect(handle.shouldSkip).toBe(true);
    expect(handle.skipReason).toContain("ANTHROPIC_API_KEY");
    expect(handle.skipReason).toMatch(/native-only/i);
  });

  it("treats an empty key as absent", () => {
    // `OPENAI_API_KEY=` in a shell exports an empty string, not an unset variable. Reading that as
    // "configured" would run the whole matrix with no credential and fail on auth — a red suite
    // blamed on the provider rather than on the environment.
    process.env.OPENAI_API_KEY = "";

    expect(resolveRealLlmEnv("openai").shouldSkip).toBe(true);
  });

  it("still opens for the native-only scenario when the provider's own key IS set", () => {
    // The accepted case for `nativeOnly` (`testing.md` § 4.2): the flag must narrow the fallback,
    // not disable the scenario. A `nativeOnly` that always skipped would satisfy the test above
    // while silently deleting every native-capability test in the matrix.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const handle = resolveRealLlmEnv("anthropic", { nativeOnly: true });

    expect(handle.shouldSkip).toBe(false);
    expect(handle.provider).toBe("anthropic");
  });
});
