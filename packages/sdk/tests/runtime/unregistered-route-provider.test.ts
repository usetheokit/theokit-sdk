/**
 * A provider name in `providers.routes` that no profile is registered under must be reported as
 * such, not as missing credentials.
 *
 * Measured at theokit-sdk 66bbb3a9 (loop-surface-closure finding F-afb3ae03): with
 * `routes: [{ capability: "chat", provider: "no-such-provider" }]` and a key passed, the run ends
 * with a `ConfigurationError` (`provider_unresolved`) whose message says "Set ANTHROPIC_API_KEY or
 * OPENAI_API_KEY / OPENROUTER_API_KEY." The key is already set; the name is the mistake, and the
 * message neither says so nor lists the names that exist.
 *
 * The class and code assertions run first, so a run that fails for another reason cannot be read
 * as this defect: only the message assertions name it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../src/agent.js";
import { ConfigurationError } from "../../src/errors.js";
import { resolveProviderChain } from "../../src/internal/llm/router.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../../src/internal/session/agent-session.js";

const UNREGISTERED_PROVIDER = "no-such-provider";
const OPENROUTER_SHAPED_KEY = `sk-or-v1-${"0".repeat(64)}`;
const CREDENTIALS_HINT = "Set ANTHROPIC_API_KEY";

describe("an unregistered provider in providers.routes", () => {
  let root: string;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-unregistered-route-provider-"));
  });

  afterEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("names_the_unregistered_provider_without_a_credentials_hint_and_sends_nothing", async () => {
    const recordingFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", recordingFetch);
    const agent = await Agent.create({
      apiKey: OPENROUTER_SHAPED_KEY,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: UNREGISTERED_PROVIDER }] },
    });
    try {
      const run = await agent.send("hi");
      const result = await run.wait();

      expect(result.status).toBe("error");
      const cause = result.error?.cause;
      expect(cause).toBeInstanceOf(ConfigurationError);
      expect((cause as ConfigurationError).code).toBe("provider_unresolved");

      const message = (cause as ConfigurationError).message;
      expect(message).toContain(`"${UNREGISTERED_PROVIDER}"`);
      expect(message).toContain("is not a known provider");
      expect(message).toContain("openrouter");
      expect(message).not.toContain(CREDENTIALS_HINT);
      expect(recordingFetch).toHaveBeenCalledTimes(0);
    } finally {
      await agent.dispose();
    }
  });

  it("keeps_the_credentials_hint_for_a_known_provider_with_no_key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    let caught: unknown;
    try {
      resolveProviderChain({ primary: "openrouter" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).message).toBe(
      "No provider client could be resolved (primary=openrouter). " +
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY / OPENROUTER_API_KEY.",
    );
  });
});
