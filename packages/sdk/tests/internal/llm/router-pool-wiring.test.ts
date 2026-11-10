/**
 * Tests for router pool wiring (T4.1, ADRs D130, D132).
 *
 * Validates that:
 * - apiKeys with ≥2 entries triggers PoolAwareLlmClient wrap
 * - apiKeys with 0/1 entry falls back to single-key path
 * - empty string keys are filtered
 * - unknown provider in apiKeys emits stderr warn (EC-B)
 * - strategy defaults to fill_first when omitted
 */

/**
 * Peels off ALL decorators down to the real transport, in a loop.
 *
 * In a loop and not two `if`s: the order in which router and chain-builder wrap is not fixed, and one
 * positional unwrapping now depends on it. M93 — `RetryingLlmClient` was the second
 * decorator to arrive; the third must not break these tests again.
 */
function unwrapDecorators(client: LlmClient): LlmClient {
  let current = client;
  for (;;) {
    if (current instanceof RetryingLlmClient) current = current.inner;
    else if (current instanceof FaultInjectingLlmClient) current = current.inner;
    else return current;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../../src/errors.js";
import { FaultInjectingLlmClient } from "../../../src/internal/llm/fault-injection.js";
import { PoolAwareLlmClient } from "../../../src/internal/llm/pool-aware-client.js";
import { RetryingLlmClient } from "../../../src/internal/llm/retrying-client.js";
import {
  _resetCredentialPoolWarnings,
  resolveProviderChain,
} from "../../../src/internal/llm/router.js";
import type { LlmClient } from "../../../src/internal/llm/types.js";

/**
 * D14 wired router-side: every client returned by `resolveProviderChain` is
 * wrapped with `FaultInjectingLlmClient` (a transparent passthrough unless
 * the activation gate is on). Existing layered-transport assertions walk
 * one level deep — same pattern PoolAware uses for its inner transport.
 */
function unwrapFaultInjection(client: LlmClient): LlmClient {
  // M93 — unwrap BOTH decorators. `RetryingLlmClient` slotted in between the router and the pool;
  // the intent of these tests ("the router uses the pool") still holds, there is simply now one
  // layer in the path.
  return unwrapDecorators(client);
}

import {
  _resetBuiltinsRegistered,
  registerBuiltins,
} from "../../../src/internal/providers/builtin/index.js";
import { _resetProvidersForTests } from "../../../src/internal/providers/registry.js";
import { validateAgentOptions } from "../../../src/internal/runtime/validation/validate-agent-options.js";
import type { AgentOptions } from "../../../src/types/agent.js";

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  _resetProvidersForTests();
  _resetBuiltinsRegistered();
  _resetCredentialPoolWarnings();
  registerBuiltins();
  for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    ORIG_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetProvidersForTests();
  _resetBuiltinsRegistered();
  _resetCredentialPoolWarnings();
});

describe("router pool wiring (T4.1)", () => {
  it("uses pool when apiKeys has 2 entries", () => {
    const chain = resolveProviderChain({
      primary: "openrouter",
      apiKeys: { openrouter: ["k1", "k2"] },
    });
    expect(chain).toHaveLength(1);
    expect(unwrapFaultInjection(chain[0]!)).toBeInstanceOf(PoolAwareLlmClient);
  });

  it("falls back to single-key path when apiKeys undefined", () => {
    process.env.OPENROUTER_API_KEY = "from-env";
    const chain = resolveProviderChain({ primary: "openrouter" });
    expect(chain).toHaveLength(1);
    expect(unwrapFaultInjection(chain[0]!)).not.toBeInstanceOf(PoolAwareLlmClient);
  });

  it("falls back to single-key path when apiKeys array is empty", () => {
    process.env.OPENROUTER_API_KEY = "from-env";
    const chain = resolveProviderChain({
      primary: "openrouter",
      apiKeys: { openrouter: [] },
    });
    expect(chain).toHaveLength(1);
    expect(unwrapFaultInjection(chain[0]!)).not.toBeInstanceOf(PoolAwareLlmClient);
  });

  it("uses 1-entry pool fast-path (no PoolAware wrap) when only 1 effective key", () => {
    const chain = resolveProviderChain({
      primary: "openrouter",
      apiKeys: { openrouter: ["solo"] },
    });
    expect(chain).toHaveLength(1);
    expect(unwrapFaultInjection(chain[0]!)).not.toBeInstanceOf(PoolAwareLlmClient);
  });

  it("filters empty string keys before counting", () => {
    process.env.OPENROUTER_API_KEY = "fallback";
    const chain = resolveProviderChain({
      primary: "openrouter",
      apiKeys: { openrouter: ["", "real-key"] },
    });
    expect(chain).toHaveLength(1);
    // Only 1 effective key → single-key path
    expect(unwrapFaultInjection(chain[0]!)).not.toBeInstanceOf(PoolAwareLlmClient);
  });

  // EC-B: warn on unknown provider in apiKeys
  it("warns once on unknown provider in apiKeys (EC-B)", () => {
    const warn = vi.spyOn(process.stderr, "write");
    process.env.OPENROUTER_API_KEY = "k";
    resolveProviderChain({
      primary: "openrouter",
      apiKeys: { opnrouter: ["typo-key"] }, // typo
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown provider "opnrouter"'));
    warn.mockRestore();
  });

  it("warns when a fallback names an unknown provider, and still resolves the primary", () => {
    const warn = vi.spyOn(process.stderr, "write");
    process.env.OPENROUTER_API_KEY = "k";
    const chain = resolveProviderChain({ primary: "openrouter", fallback: ["nopeprovider"] });
    expect(chain).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown provider "nopeprovider"'));
    warn.mockRestore();
  });

  // Named for what it checks. It was "strategy defaults to fill_first when omitted" and closed with
  // `// Default strategy used — we verify behavior by selecting and getting "a" twice`, describing a
  // verification in the present tense that is not in the file: no selection happens, nothing observes
  // the strategy, and a pool built with round_robin passes identically. The pool is a private field,
  // so observing it from here would mean casting past the encapsulation — and the strategy's actual
  // behaviour already has a home: `credential-pool.test.ts` ("fill_first: returns entries[0] until
  // exhausted").
  it("three keys for one provider produce a pooled client, with no strategy specified", () => {
    const chain = resolveProviderChain({
      primary: "openrouter",
      apiKeys: { openrouter: ["a", "b", "c"] },
      // no credentialPoolStrategy
    });
    expect(unwrapFaultInjection(chain[0]!)).toBeInstanceOf(PoolAwareLlmClient);
  });

  it("validateAgentOptions throws on apiKey + apiKeys[provider] ambiguity (EC-J)", () => {
    const opts: AgentOptions = {
      apiKey: "k-explicit",
      model: { id: "test" },
      local: {},
      providers: { routes: [], apiKeys: { openrouter: ["k-pool-1"] } },
    } as AgentOptions;
    expect(() => validateAgentOptions(opts)).toThrow(ConfigurationError);
  });

  it("validateAgentOptions accepts apiKey alone (no apiKeys)", () => {
    const opts: AgentOptions = {
      apiKey: "k-explicit",
      model: { id: "test" },
      local: {},
    } as AgentOptions;
    expect(() => validateAgentOptions(opts)).not.toThrow();
  });

  it("validateAgentOptions accepts apiKeys alone (no apiKey)", () => {
    const opts: AgentOptions = {
      model: { id: "test" },
      local: {},
      providers: { routes: [], apiKeys: { openrouter: ["k1", "k2"] } },
    } as AgentOptions;
    expect(() => validateAgentOptions(opts)).not.toThrow();
  });
});
