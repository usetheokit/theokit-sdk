/**
 * A primary provider with no registered profile is a different mistake from a registered provider
 * with no credential, and the router's error says which one happened (B-499).
 *
 * The registry is reset around every test, as `router.test.ts` does, so a profile registered here
 * cannot leak into another file and the list of names is exactly the builtins plus what a test adds.
 *
 * Only the primary is checked. An unregistered fallback beside a primary that resolves is dropped
 * in silence, which is B-536's scope, not this file's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigurationError } from "../../../src/errors.js";
import { resolveProviderChain } from "../../../src/internal/llm/router.js";
import { _resetBuiltinsRegistered } from "../../../src/internal/providers/builtin/index.js";
import {
  _resetProvidersForTests,
  getProviderProfile,
  listProviders,
  registerProvider,
} from "../../../src/internal/providers/registry.js";

const CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const REGISTERED_PREFIX = "Registered providers: ";
const savedEnv: Record<string, string | undefined> = {};

function captureResolutionError(primary: string): ConfigurationError {
  try {
    resolveProviderChain({ primary });
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error(`expected resolveProviderChain({ primary: "${primary}" }) to throw`);
}

function registeredNamesIn(message: string): string {
  const start = message.indexOf(REGISTERED_PREFIX);
  expect(start).toBeGreaterThanOrEqual(0);
  return message.slice(start + REGISTERED_PREFIX.length).replace(/\.$/, "");
}

beforeEach(() => {
  _resetProvidersForTests();
  _resetBuiltinsRegistered();
  for (const name of CREDENTIAL_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetProvidersForTests();
  _resetBuiltinsRegistered();
});

describe("an unregistered primary provider", () => {
  it("lists_a_plugin_registered_provider_among_the_known_names", () => {
    registerProvider({
      name: "acme-test-provider",
      apiMode: "chat_completions",
      envVars: ["ACME_TEST_PROVIDER_API_KEY"],
      authType: "api_key",
      baseUrl: "https://acme.invalid/v1",
      fallbackModels: ["acme-model"],
    });

    const error = captureResolutionError("no-such-provider");

    expect(error.code).toBe("provider_unresolved");
    expect(error.message).toContain('"no-such-provider" is not a known provider');
    expect(registeredNamesIn(error.message).split(", ")).toContain("acme-test-provider");
  });

  it("lists_each_registered_provider_once_in_sorted_order", () => {
    const error = captureResolutionError("no-such-provider");

    const listed = registeredNamesIn(error.message).split(", ");
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)));
    expect([...listed].sort((a, b) => a.localeCompare(b))).toEqual(
      listProviders()
        .map((profile) => profile.name)
        .sort((a, b) => a.localeCompare(b)),
    );
    expect(error.message).toBe(
      `No provider client could be resolved: "no-such-provider" is not a known provider. ` +
        `Registered providers: ${listed.join(", ")}.`,
    );
  });

  it("lists_providers_in_locale_order_not_utf16_code_unit_order", () => {
    for (const name of ["zeta", "épsilon"]) {
      registerProvider({
        name,
        apiMode: "chat_completions",
        envVars: [`${name.toUpperCase()}_TEST_API_KEY`],
        authType: "api_key",
        baseUrl: "https://acme.invalid/v1",
        fallbackModels: ["acme-model"],
      });
    }

    const listed = registeredNamesIn(captureResolutionError("no-such-provider").message).split(
      ", ",
    );

    // The default string sort puts "zeta" (U+007A) before "épsilon" (U+00E9); locale order does not.
    expect(listed.indexOf("épsilon")).toBeGreaterThanOrEqual(0);
    expect(listed.indexOf("épsilon")).toBeLessThan(listed.indexOf("zeta"));
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)));
  });

  it("names_an_empty_provider_as_not_a_known_provider", () => {
    const error = captureResolutionError("");

    expect(error.code).toBe("provider_unresolved");
    expect(error.message).toContain('"" is not a known provider');
    expect(error.message).not.toContain("Set ANTHROPIC_API_KEY");
  });
});

describe("an unregistered primary beside a fallback that resolves", () => {
  it("runs_on_the_fallback_without_naming_the_unregistered_primary", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";

    const chain = resolveProviderChain({ primary: "no-such-provider", fallback: ["openrouter"] });

    expect(chain).toHaveLength(1);
  });
});

describe("a registered primary provider with no credential", () => {
  it("keeps_the_credentials_hint_for_a_known_provider_written_in_another_case", () => {
    const error = captureResolutionError("OpenRouter");

    expect(error.code).toBe("provider_unresolved");
    expect(error.message).toBe(
      "No provider client could be resolved (primary=OpenRouter). " +
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY / OPENROUTER_API_KEY.",
    );
  });

  it("keeps_the_credentials_hint_for_a_provider_named_by_its_alias", () => {
    const error = captureResolutionError("or");

    expect(error.code).toBe("provider_unresolved");
    expect(error.message).toBe(
      "No provider client could be resolved (primary=or). " +
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY / OPENROUTER_API_KEY.",
    );
  });
});

describe("a profile registered with uppercase letters", () => {
  // Replaces the two lowercase-rule message tests: the registry now lowercases, so both are reachable.
  it("is_reached_by_a_route_naming_the_name_and_by_one_naming_the_alias", () => {
    process.env.ACME_AI_TEST_API_KEY = "k";
    try {
      registerProvider({
        name: "AcmeAI",
        aliases: ["AcmeX"],
        apiMode: "chat_completions",
        envVars: ["ACME_AI_TEST_API_KEY"],
        authType: "api_key",
        baseUrl: "https://acme.invalid/v1",
        fallbackModels: ["acme-model"],
      });
      expect(getProviderProfile("AcmeAI")?.name).toBe("acmeai");
      expect(getProviderProfile("AcmeX")?.name).toBe("acmeai");
      expect(resolveProviderChain({ primary: "AcmeAI" })).toHaveLength(1);
      expect(resolveProviderChain({ primary: "AcmeX" })).toHaveLength(1);
    } finally {
      delete process.env.ACME_AI_TEST_API_KEY;
    }
  });
});
