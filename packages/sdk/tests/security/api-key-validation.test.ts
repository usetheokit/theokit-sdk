/**
 * T1.3 — API key boundary validation tests.
 *
 * The validator runs early in `Agent.create` so malformed keys (whitespace,
 * sub-16-char fragments, embedded whitespace, known-provider prefix
 * mismatches) get a precise `AuthenticationError({code:"malformed_api_key"})`
 * BEFORE the SDK attempts a provider round-trip. Live validation (actual
 * `fetch` against the provider URL) still happens later.
 */

import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "../../src/errors.js";
import { Agent } from "../../src/index.js";
import {
  type ApiKeyValidationResult,
  validateApiKeyShape,
} from "../../src/internal/auth/api-key-validator.js";
import * as fixtureMode from "../../src/internal/runtime/fixtures/fixture-mode.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

// Agent.create defaults its workspace to process.cwd(), which during a test run is the
// package itself — this file created agents without saying where, and the state landed in
// packages/sdk/.theokit/. See useTempCwd's docblock for the 540 MB that bought.
useTempCwd();

describe("T1.3 — validateApiKeyShape unit", () => {
  function assertMalformed(
    result: ApiKeyValidationResult,
    reason: ApiKeyValidationResult extends infer R
      ? R extends { reason: infer Why }
        ? Why
        : never
      : never,
  ): void {
    expect(result.malformed).toBe(true);
    if (!result.malformed) throw new Error("type narrowing failed");
    expect(result.reason).toBe(reason);
  }

  it("rejects empty string", () => {
    assertMalformed(validateApiKeyShape(""), "empty");
  });

  it("rejects undefined", () => {
    assertMalformed(validateApiKeyShape(undefined), "empty");
  });

  it("rejects whitespace-only", () => {
    assertMalformed(validateApiKeyShape("   "), "whitespace_only");
    assertMalformed(validateApiKeyShape("\t\n"), "whitespace_only");
  });

  it("rejects sub-16-char fragments like 'x'", () => {
    assertMalformed(validateApiKeyShape("x"), "too_short");
    assertMalformed(validateApiKeyShape("sk-short"), "too_short");
  });

  it("non-strict mode accepts a short key but still rejects empty and whitespace-only", () => {
    expect(validateApiKeyShape("x", { strict: false }).malformed).toBe(false);
    assertMalformed(validateApiKeyShape("", { strict: false }), "empty");
    assertMalformed(validateApiKeyShape("  ", { strict: false }), "whitespace_only");
  });

  it("rejects keys with embedded whitespace", () => {
    assertMalformed(validateApiKeyShape("sk-abcdefghij klmnopqrstuvwxyz"), "embedded_whitespace");
  });

  it("flags provider prefix mismatch for openai", () => {
    assertMalformed(
      validateApiKeyShape("ak-abcdefghijklmnopqrstuvwxyz", "openai"),
      "missing_known_prefix",
    );
  });

  it("accepts a well-shaped openai key with explicit provider hint", () => {
    expect(validateApiKeyShape("sk-abcdefghijklmnopqrstuvwxyz", "openai").malformed).toBe(false);
  });

  it("accepts a well-shaped openrouter key", () => {
    expect(validateApiKeyShape("sk-or-v1-abcdefghijklmnopqrstuvwxyz", "openrouter").malformed).toBe(
      false,
    );
  });

  it("bypasses validation for fixture keys (theo_test_*)", () => {
    expect(validateApiKeyShape("theo_test_x").malformed).toBe(false);
    expect(validateApiKeyShape("theo_test_fixture").malformed).toBe(false);
  });

  it("bypasses validation for local-runtime mock key 'local'", () => {
    expect(validateApiKeyShape("local").malformed).toBe(false);
  });

  it("accepts long opaque keys when no provider hint is passed", () => {
    expect(validateApiKeyShape("very-long-opaque-key-abc123-xyz789").malformed).toBe(false);
  });
});

describe("T1.3 — Agent.create boundary validation", () => {
  it("throws AuthenticationError with code 'malformed_api_key' on 'x'", async () => {
    await expect(
      Agent.create({ apiKey: "x", model: { id: "openai/gpt-4o-mini" } }),
    ).rejects.toMatchObject({
      name: "AuthenticationError",
      code: "malformed_api_key",
    });
  });

  it("throws AuthenticationError on whitespace-only key", async () => {
    await expect(
      Agent.create({ apiKey: "   ", model: { id: "openai/gpt-4o-mini" } }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("accepts theo_test_fixture (existing fixture path)", async () => {
    // B-009. The one positive case in a file of rejections, and it asserted nothing — a rejected
    // `Agent.create` throws, so an unhandled throw was standing in for "accepts".
    //
    // Writing the obvious `.resolves` assertion exposed something sharper, and it is why this test
    // needs the spy: acceptance of this key does NOT depend on the fixture path. Measured — with
    // BOTH fixture guards disabled (`isFixtureApiKey` returning false AND the validator's
    // `theo_test_` branch removed), `Agent.create` still resolves. Not because the key is
    // well-formed — under `{ strict: true, provider: "openai" }` it is rejected with
    // `missing_known_prefix` — but because strictness is never switched on: `shouldUseRealLocalRuntime`
    // consults `isLocalNoAuthProviderAvailable()`, which returns `true` unconditionally
    // (`fixture-mode.ts:158`, "the SDK ships Ollama as a builtin"), so `willFlowToProvider` is false
    // at `agent-helpers.ts:129`, so `validateApiKeyShape` takes its `strict === false` early return.
    //
    // So `.resolves` alone would pin "a key is accepted while no provider-strict check runs", not
    // "the fixture path is taken" — which is what the test is named for.
    const fixtureCheck = vi.spyOn(fixtureMode, "isFixtureApiKey");
    try {
      const created = Agent.create({
        apiKey: "theo_test_fixture",
        model: { id: "openai/gpt-4o-mini" },
      });
      await expect(created, "a theo_test_ fixture key must be accepted").resolves.toBeDefined();

      const agent = await created;
      expect(agent.agentId, "and must yield a usable, identified agent").toBeTruthy();
      expect(
        fixtureCheck.mock.results.some((r) => r.type === "return" && r.value === true),
        "and it must be accepted AS a fixture key — not merely as a well-formed one",
      ).toBe(true);
      await agent.dispose();
    } finally {
      fixtureCheck.mockRestore();
    }
  });
});
