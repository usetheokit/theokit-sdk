/**
 * T2.1 — Finding B end-to-end gate (`sdk-error-packaging-fix-plan` v1.1).
 *
 * Validates the FULL pipeline:
 *   Agent.create({ apiKey, model }) → agent.send(...) → run.wait() →
 *   result.error populated  ∧  zero SDKAssistantMessage carries error content.
 *
 * Where the unit tests in `tests/internal/agent-loop/error-packaging.test.ts`
 * pin the loop catch path surgically, this one exercises the runtime wire:
 *   - `runAgentLoop` returns `{ error }`
 *   - `executeAgentLoop` copies it to `script.errorDetail`
 *   - `fixture-run-base.buildResult` exposes it as `RunResult.error`
 *   - `Run.stream()` never yields a typed-error-shaped assistant message
 *
 * Transport is intercepted via `vi.stubGlobal("fetch", …)` so we do not
 * touch the network and the test stays deterministic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../src/agent.js";
import { ConfigurationError } from "../../src/errors.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../../src/internal/session/agent-session.js";

const REAL_KEY_SHAPE = "sk-or-v1-error-packaging-e2e-1234567890abcdef";
const MODEL = { id: "openai/gpt-4o-mini" };

function mockFetch401(): typeof fetch {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        error: {
          message: "Invalid API key provided",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
      {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      },
    ) as Response;
  }) as unknown as typeof fetch;
}

function findLeakedErrorAssistant(events: ReadonlyArray<unknown>): unknown | undefined {
  return events.find((e): boolean => {
    if (typeof e !== "object" || e === null) return false;
    const ev = e as { type?: string };
    if (ev.type !== "assistant") return false;
    const json = JSON.stringify(e);
    return /Invalid API key|HTTP 401|invalid_api_key|auth_failed|Unauthorized/i.test(json);
  });
}

/**
 * The reported failure (#338 item 3): OpenRouter credit runs out mid-round and answers 402 with a
 * `quota_exceeded` reason. The reporter saw `status: "error"`, `result` undefined and nothing else,
 * and spent hours on the wrong cause — the provider's reason was only visible by installing a
 * diagnostics sink and consuming the stream.
 */
function mockFetch402QuotaExceeded(): typeof fetch {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        error: {
          message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
          type: "insufficient_quota",
          code: "quota_exceeded",
        },
      }),
      {
        status: 402,
        statusText: "Payment Required",
        headers: { "content-type": "application/json" },
      },
    ) as Response;
  }) as unknown as typeof fetch;
}

/**
 * OpenRouter's answer for a model id it no longer serves (observed live 2026-10-20 for
 * "deepseek/deepseek-r1"). The provider's text is the only place the model id appears.
 */
function mockFetch404MissingModel(modelId: string): typeof fetch {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({ error: { message: `No endpoints found for ${modelId}.`, code: 404 } }),
      {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      },
    ) as Response;
  }) as unknown as typeof fetch;
}

describe("RunResult.error end-to-end (Finding B — full pipeline)", () => {
  let root: string;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-error-pkg-e2e-"));
  });

  afterEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("provider 401 → RunResult.error populated + no leaked assistant", async () => {
    // Stub env so the router builds an OpenAI-compat client and our mocked
    // fetch fires. Without this, `resolveProviderChain` throws a
    // ConfigurationError BEFORE the loop catch path (which is also
    // captured via `result.error` but doesn't exercise the loop seam).
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test-fixture-key");
    vi.stubGlobal("fetch", mockFetch401());
    const agent = await Agent.create({
      apiKey: REAL_KEY_SHAPE,
      model: MODEL,
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const run = await agent.send("hi");
      const result = await run.wait();

      // FINDING B INVARIANT 1: result.status === "error" + structured error set
      expect(result.status).toBe("error");
      expect(result.error).toBeDefined();
      expect(result.error?.message).toMatch(/401|Invalid API key|Unauthorized/i);

      // FINDING B INVARIANT 2: NO assistant message in the stream carries
      // the error text — that was exactly the leak pre-fix.
      const events: unknown[] = [];
      for await (const event of run.stream()) {
        events.push(event);
      }
      const leaked = findLeakedErrorAssistant(events);
      expect(leaked, "Finding B: error MUST NOT leak as assistant content").toBeUndefined();
    } finally {
      await agent.dispose();
    }
  });

  it("EC-6 double-negative: chaos consumer can rely on (a)+(b) jointly", async () => {
    // EC-6 MUST FIX — chaos tests can fail with weak single-check
    // "status === 'error'" — assertion. The fix lets consumers assert
    // both "error.code populated" AND "no assistant leak" — i.e., the
    // contract the patched SDK promises.
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test-fixture-key");
    vi.stubGlobal("fetch", mockFetch401());
    const agent = await Agent.create({
      apiKey: REAL_KEY_SHAPE,
      model: MODEL,
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const run = await agent.send("hi");
      const result = await run.wait();

      // (a) structured detail exists
      expect(result.error?.message.length).toBeGreaterThan(0);

      // (b) no leak — drain stream and prove negative
      const events: unknown[] = [];
      for await (const event of run.stream()) {
        events.push(event);
      }
      const assistantTexts = events
        .filter((e): e is { type: "assistant"; message: { content: Array<{ text?: string }> } } => {
          if (typeof e !== "object" || e === null) return false;
          return (e as { type?: string }).type === "assistant";
        })
        .flatMap((e) => e.message.content.map((p) => p.text ?? ""));

      // None of the assistant payloads should contain the verbatim error.
      for (const text of assistantTexts) {
        expect(text).not.toMatch(/Invalid API key|401|invalid_api_key/i);
      }
    } finally {
      await agent.dispose();
    }
  });
});

describe("a provider's REASON reaches RunResult without the stream (#338 item 3)", () => {
  let root: string;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-quota-e2e-"));
  });

  afterEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("carries the quota reason on result.error for a caller who only ever calls wait()", async () => {
    // `run.wait()` is the path the docs present first, and the reported diagnosis cost came from
    // it reporting an outcome with no cause. The 401 case above is already covered; this pins the
    // one that was actually met in the field, and pins it at wait() rather than through the stream.
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test-fixture-key");
    vi.stubGlobal("fetch", mockFetch402QuotaExceeded());
    const agent = await Agent.create({
      apiKey: REAL_KEY_SHAPE,
      model: MODEL,
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const result = await (await agent.send("hi")).wait();

      expect(result.status).toBe("error");
      expect(result.error).toBeDefined();
      // The reason, not merely "something failed": a caller has to be able to tell a billing
      // problem from a rate limit from a bad key without attaching a diagnostics sink.
      expect(result.error?.message ?? "").toContain("quota_exceeded");
      expect(result.error?.message ?? "").toContain("openrouter");
    } finally {
      await agent.dispose();
    }
  });

  it("missing_model_404_ends_the_run_with_a_ConfigurationError_naming_the_model", async () => {
    // A retired model id is a configuration problem: the run must say which model, with a
    // class a caller can branch on, rather than an UnknownAgentError naming neither.
    const retiredModel = "deepseek/deepseek-r1";
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test-fixture-key");
    vi.stubGlobal("fetch", mockFetch404MissingModel(retiredModel));
    const agent = await Agent.create({
      apiKey: REAL_KEY_SHAPE,
      model: { id: retiredModel },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const result = await (await agent.send("hi")).wait();

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("model_unavailable");
      expect(result.error?.cause).toBeInstanceOf(ConfigurationError);
      expect(result.error?.message ?? "").toContain(retiredModel);
    } finally {
      await agent.dispose();
    }
  });
});
