/**
 * B-130 / B-129 — the strict API-key shape check could never run, for any input.
 *
 * `createLocalAgent` computed
 *
 *   const willFlowToProvider = !isFixtureApiKey(apiKey) && !shouldUseRealLocalRuntime(apiKey);
 *
 * and `shouldUseRealLocalRuntime` ORs in `isLocalNoAuthProviderAvailable()`, which is a hardcoded
 * `return true` — the SDK ships Ollama as a builtin. So for a fixture key the first clause fails, and
 * for every other key the second does: `willFlowToProvider` was **always false**, `validateApiKeyShape`
 * was always called with `strict: false` and no provider, and the entire strict branch plus the
 * provider-prefix check were unreachable for every possible input.
 *
 * Measured 2026-08-20 over five representative keys before the fix; false in all five.
 *
 * The consequence is the one `rules/error-handling.md` § 1 exists to prevent: a malformed key for a
 * NAMED remote provider was accepted at the boundary and failed later, wherever it happened to be
 * used first — a cheap rejection turned into an expensive one.
 *
 * The fix separates two questions that had been sharing one predicate:
 *
 *   "is a local runtime available?"        -> shouldUseRealLocalRuntime, still used by dispatch
 *   "does this key go to a named provider
 *    that authenticates with it?"          -> the provider's own authType
 *
 * These tests exist to keep them separate. They assert reachability of the strict branch, not any
 * particular rejection message — the messages belong to the validator's own suite.
 */

import { describe, expect, it } from "vitest";

import { AuthenticationError } from "../src/errors.js";
import { Agent, Provider } from "../src/index.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

// This file passed `cwd: process.cwd()`, which during a test run is the package itself, so
// every agent it created persisted a real session into packages/sdk/.theokit/. The helper
// makes process.cwd() report a throwaway directory for this file only.
useTempCwd();

const create = (apiKey: string, modelId: string) =>
  Agent.create({ apiKey, model: { id: modelId }, local: { cwd: process.cwd() } });

describe("strict API-key validation is reachable", () => {
  it("test_a_malformed_key_for_a_named_auth_provider_is_refused_at_the_boundary", async () => {
    // openai requires an api key, so the strict branch applies and the prefix check bites.
    await expect(create("not-a-real-openai-key", "openai/gpt-4o-mini")).rejects.toMatchObject({
      name: "AuthenticationError",
      code: "malformed_api_key",
    });
  });

  it("test_the_refusal_names_the_provider_and_the_expected_prefix", async () => {
    // A negative case must identify WHICH guard fired, not merely that something threw.
    const err = await create("not-a-real-openai-key", "openai/gpt-4o-mini").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).message).toMatch(/openai/);
    expect((err as AuthenticationError).message).toMatch(/sk-/);
  });

  it("test_a_well_formed_key_for_the_same_provider_is_ACCEPTED", async () => {
    // testing.md § 4.2 — without this row, a predicate that rejected every key would pass the two
    // cases above. This is the half that tells a correct guard from one that refuses everything.
    const agent = await create(`sk-${"x".repeat(40)}`, "openai/gpt-4o-mini");

    expect(agent).toBeDefined();
    await agent.dispose();
  });

  it("test_a_no_auth_local_provider_accepts_any_key_shape", async () => {
    // ollama is `authType: "none"` — it ignores the key entirely, so strictness there would reject
    // input the runtime does not even read. The separation exists precisely to keep this working.
    const agent = await create("whatever-ollama-ignores-this", "ollama/llama3");

    expect(agent).toBeDefined();
    await agent.dispose();
  });

  it("test_a_fixture_key_is_still_exempt", async () => {
    const agent = await create("theo_test_fixture_key", "openai/gpt-4o-mini");

    expect(agent).toBeDefined();
    await agent.dispose();
  });

  it("test_a_custom_api_key_provider_accepts_a_one_char_key_before_and_after_registration", async () => {
    // #1118 — a profile from Provider.create makes the prefix "known", but the SDK still cannot
    // attribute the key to a real provider, so the strict 16-char floor must not apply.
    const plugin = Provider.create({
      name: "shortkeybench",
      apiMode: "chat_completions",
      envVars: [],
      baseUrl: "http://127.0.0.1:9/v1",
      authType: "api_key",
      fallbackModels: [],
    });
    const createWithPlugin = () =>
      Agent.create({
        apiKey: "x",
        model: { id: "shortkeybench/x" },
        local: { cwd: process.cwd() },
        plugins: [plugin],
      });
    for (let i = 0; i < 2; i++) {
      const agent = await createWithPlugin();
      expect(agent).toBeDefined();
      await agent.dispose();
    }
  });

  it("test_a_custom_provider_still_refuses_a_whitespace_only_key", async () => {
    await expect(create("   ", "shortkeybench/x")).rejects.toMatchObject({
      code: "malformed_api_key",
    });
  });
});
