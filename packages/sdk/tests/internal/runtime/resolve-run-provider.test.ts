/**
 * Regression cover for the production caller of the model-provider wiring.
 *
 * `resolveRunProvider` is the seam `buildLoopInputs` uses on every real run; it
 * MUST register plugin-contributed provider profiles before the prefix-inference
 * lookup, else `model: { id: "myprov/model" }` would not resolve. Without this
 * test, deleting the `registerPluginProviderProfiles` call would pass every
 * other suite (the integration test exercises the helper directly, not the
 * caller).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Provider } from "../../../src/index.js";
import type { CreateRealLocalRunOptions } from "../../../src/internal/local-agent/real-local-run.js";
import {
  _resetPluginProviderAnnounce,
  mergeExplicitApiKey,
  resolveRunProvider,
} from "../../../src/internal/local-agent/real-local-run-provider.js";
import { PluginManager } from "../../../src/internal/plugins/manager.js";
import {
  _resetBuiltinsRegistered,
  registerBuiltins,
} from "../../../src/internal/providers/builtin/index.js";
import {
  _resetProvidersForTests,
  getProviderProfile,
  registerProvider,
} from "../../../src/internal/providers/registry.js";
import type { ProviderProfile } from "../../../src/internal/providers/types.js";

const customProfile: ProviderProfile = {
  name: "custom-llm",
  apiMode: "chat_completions",
  envVars: ["CUSTOM_LLM_API_KEY"],
  authType: "none",
  baseUrl: "https://api.custom-llm.test/v1",
  fallbackModels: ["custom-llm/default"],
};

function optionsWith(
  pluginManager: PluginManager | undefined,
  modelId: string | undefined,
): CreateRealLocalRunOptions {
  return {
    model: modelId === undefined ? undefined : { id: modelId },
    agentOptions: {},
    ...(pluginManager !== undefined ? { pluginManager } : {}),
  } as unknown as CreateRealLocalRunOptions;
}

describe("resolveRunProvider — model-provider plugin wiring (caller)", () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetBuiltinsRegistered();
    _resetPluginProviderAnnounce();
    registerBuiltins();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a plugin provider so the prefix selects it as primary", async () => {
    const mgr = new PluginManager();
    await mgr.initialize([Provider.create(customProfile)]);

    const { primary, effectiveModelId } = resolveRunProvider(
      optionsWith(mgr, "custom-llm/default"),
    );

    // Caller invoked the bridge → registry now resolves the custom provider.
    expect(getProviderProfile("custom-llm")).toBeDefined();
    // Prefix inference picked the now-registered plugin provider.
    expect(primary).toBe("custom-llm");
    expect(effectiveModelId).toBe("default");
  });

  it("emits a one-shot observability line when plugin providers are registered", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const mgr = new PluginManager();
    await mgr.initialize([Provider.create(customProfile)]);

    resolveRunProvider(optionsWith(mgr, "custom-llm/default"));
    resolveRunProvider(optionsWith(mgr, "custom-llm/default")); // second run

    const lines = stderr.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("registered") && l.includes("plugin provider profile"));
    expect(lines).toHaveLength(1); // one-shot per process, not per run
    expect(lines[0]).toContain("custom-llm");
  });

  it("no plugin manager → registers nothing and does not throw", () => {
    const { primary } = resolveRunProvider(optionsWith(undefined, undefined));
    expect(getProviderProfile("custom-llm")).toBeUndefined();
    expect(typeof primary).toBe("string"); // falls back to env detection / default
  });
});

/**
 * M4 (plan m4-provider-routing-apikey-fix) — the explicitly-passed API key is the
 * ground-truth credential of which endpoint will be called; it MUST outrank the
 * model-prefix inference for choosing `primary`. A `sk-or-` (OpenRouter) key +
 * an `openai/gpt-4o-mini` model MUST route to OpenRouter, keeping the full slug.
 */
function optionsWithKey(args: {
  modelId?: string;
  apiKey?: string;
  routeProvider?: string;
}): CreateRealLocalRunOptions {
  return {
    ...(args.modelId === undefined ? {} : { model: { id: args.modelId } }),
    agentOptions: {
      ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
      ...(args.routeProvider === undefined
        ? {}
        : { providers: { routes: [{ provider: args.routeProvider }] } }),
    },
  } as unknown as CreateRealLocalRunOptions;
}

describe("resolveRunProvider — explicit API key selects the provider (M4)", () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetBuiltinsRegistered();
    _resetPluginProviderAnnounce();
    registerBuiltins();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("openrouter key routes an openai/… model to openrouter keeping the full slug", () => {
    const { primary, effectiveModelId } = resolveRunProvider(
      optionsWithKey({ apiKey: "sk-or-v1-test", modelId: "openai/gpt-4o-mini" }),
    );
    expect(primary).toBe("openrouter");
    // OpenRouter's model slug legitimately embeds a vendor segment — do NOT strip.
    expect(effectiveModelId).toBe("openai/gpt-4o-mini");
  });

  it("anthropic key with anthropic/… model strips the matching prefix", () => {
    const { primary, effectiveModelId } = resolveRunProvider(
      optionsWithKey({ apiKey: "sk-ant-test", modelId: "anthropic/claude-3-5-haiku-latest" }),
    );
    expect(primary).toBe("anthropic");
    expect(effectiveModelId).toBe("claude-3-5-haiku-latest");
  });

  it("explicit providers.routes[0].provider overrides the key inference", () => {
    const { primary } = resolveRunProvider(
      optionsWithKey({
        apiKey: "sk-or-test",
        modelId: "openai/gpt-4o-mini",
        routeProvider: "openai",
      }),
    );
    expect(primary).toBe("openai");
  });

  it("a custom registered provider's prefix beats a bare sk- key (#1115)", () => {
    registerProvider({ ...customProfile, name: "bench" });
    const { primary, effectiveModelId } = resolveRunProvider(
      optionsWithKey({ apiKey: "sk-test-123", modelId: "bench/some-model" }),
    );
    expect(primary).toBe("bench");
    expect(effectiveModelId).toBe("some-model");
  });

  it("a custom registered provider's prefix beats even a sk-or- key", () => {
    registerProvider({ ...customProfile, name: "bench" });
    expect(
      resolveRunProvider(optionsWithKey({ apiKey: "sk-or-x", modelId: "bench/m" })).primary,
    ).toBe("bench");
  });

  it("a bare sk- key no longer overrules a builtin model prefix", () => {
    expect(
      resolveRunProvider(optionsWithKey({ apiKey: "sk-test", modelId: "anthropic/claude-x" }))
        .primary,
    ).toBe("anthropic");
  });

  it("a bare sk- key with no model prefix still infers openai", () => {
    expect(resolveRunProvider(optionsWithKey({ apiKey: "sk-test" })).primary).toBe("openai");
  });

  it("no key falls back to model-prefix inference (unchanged legacy behavior)", () => {
    const { primary, effectiveModelId } = resolveRunProvider(
      optionsWithKey({ modelId: "openai/gpt-4o-mini" }),
    );
    expect(primary).toBe("openai");
    expect(effectiveModelId).toBe("gpt-4o-mini");
  });
});

describe("mergeExplicitApiKey — thread the single credential into the router pool (M4)", () => {
  it("threads a single explicit key for the resolved primary", () => {
    expect(mergeExplicitApiKey(undefined, "openrouter", "sk-or-x")).toEqual({
      openrouter: ["sk-or-x"],
    });
  });

  it("an existing per-provider pool wins over the single key", () => {
    expect(
      mergeExplicitApiKey({ openrouter: ["sk-or-pool"] }, "openrouter", "sk-or-single"),
    ).toEqual({ openrouter: ["sk-or-pool"] });
  });

  it("never threads fixture or local mock keys as credentials", () => {
    expect(mergeExplicitApiKey(undefined, "openrouter", "theo_test_x")).toBeUndefined();
    expect(mergeExplicitApiKey(undefined, "openrouter", "local")).toBeUndefined();
  });
});
