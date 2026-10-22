/**
 * B-498: a run that fails on a provider 401 must hand the caller the typed error.
 *
 * The README's Errors section says every SDK error extends `TheokitAgentError`, and a UI
 * that shows "check your key" branches on `instanceof AuthenticationError`. Measured at
 * 66bbb3a9 against the packed package (audit finding F-71f11d78): `run.wait()` resolves
 * `{ status: "error" }` with `AgentOptions.throwOnError: true` too, and `result.error` is a
 * plain object; the typed error sits only at `result.error.cause`, declared `unknown`.
 *
 * The transport is a stubbed `fetch`, so no request leaves the process.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../src/agent.js";
import { AuthenticationError, UnknownAgentError } from "../../src/errors.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../../src/internal/session/agent-session.js";

const BAD_KEY = `sk-or-v1-${"0".repeat(64)}`;

function stubFetch401(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ error: { message: "User not found.", code: 401 } }), {
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "application/json" },
    });
  });
}

describe("a run that fails on a provider 401", () => {
  let root: string;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-failed-run-typed-error-"));
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

  it("resolves_with_a_typed_cause_and_unchanged_detail_without_throwOnError", async () => {
    const fetchStub = stubFetch401();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", fetchStub);
    const agent = await Agent.create({
      apiKey: BAD_KEY,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const run = await agent.send("hi");
      const result = await run.wait();

      expect(fetchStub).toHaveBeenCalled();
      expect(result.status).toBe("error");
      expect(result.error?.message).toBe("openrouter API error: auth_failed (HTTP 401)");
      expect(result.error?.code).toBe("auth_failed");
      expect(result.error?.cause).toBeInstanceOf(AuthenticationError);
    } finally {
      await agent.dispose();
    }
  });

  it("wraps_a_budget_denial_in_an_UnknownAgentError", async () => {
    const fetchStub = stubFetch401();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", fetchStub);
    const agent = await Agent.create({
      apiKey: BAD_KEY,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
      budgetTracker: {
        track: () => {},
        check: () => ({ allowed: false, reason: "custom", detail: "denied for the test" }),
        getTotal: () => ({ tokens: 0 }),
      },
    });
    try {
      const run = await agent.send("hi");
      const result = await run.wait();

      expect(result.status).toBe("error");
      expect(result.error?.message).toBe("denied for the test");
      expect(result.error?.code).toBe("custom");
      expect(result.error?.cause).toBeInstanceOf(UnknownAgentError);
      expect(result.error?.cause?.code).toBe("custom");
    } finally {
      await agent.dispose();
    }
  });
});
