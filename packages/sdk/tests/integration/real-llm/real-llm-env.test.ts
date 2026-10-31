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

// The Agent.create case below would otherwise write its state into packages/sdk/.theokit/.
useTempCwd();

const VARS =["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] as const;
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
    // The routing itself is carried by the `openrouter/` prefix (#719): a bare `anthropic/...` id
    // sends the OpenRouter key to native Anthropic, which refuses it as `malformed_api_key`.
    expect(handle.model).toBe("openrouter/anthropic/claude-3-5-haiku-latest");
  });

  it("routes a fallback model override through OpenRouter without double-prefixing (#719)", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    expect(resolveRealLlmEnv("openai", { model: "openai/gpt-4o" }).model).toBe(
      "openrouter/openai/gpt-4o",
    );
    expect(resolveRealLlmEnv("anthropic", { model: "openrouter/anthropic/claude-x" }).model).toBe(
      "openrouter/anthropic/claude-x",
    );
  });

  it("hands Agent.create a fallback handle it accepts (#719)", async () => {
    // The repro: OPENROUTER_API_KEY set, ANTHROPIC_API_KEY unset. Before the fix the anthropic
    // suites threw `malformed_api_key` at Agent.create, before a single request was sent.
    process.env.OPENROUTER_API_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const handle = resolveRealLlmEnv("anthropic");

    const agent = await Agent.create({ apiKey: handle.apiKey, model: { id: handle.model } });
    await agent.dispose();
  });

  it("honours an explicit model override", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    expect(resolveRealLlmEnv("openrouter", { model: "meta/llama-3.1-8b" }).model).toBe(
      "meta/llama-3.1-8b",
    );
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
