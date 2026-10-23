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
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../src/agent.js";
import { AuthenticationError, TheokitAgentError, UnknownAgentError } from "../../src/errors.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";
import { readRunResolving } from "../../src/internal/runtime/lifecycle/throw-on-error-run.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../../src/internal/session/agent-session.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

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

/** A `fetch` that never answers: the request hangs until its signal aborts. */
function stubFetchHanging(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
}

/** Resolve once `run` reports `status`, through the status listener rather than `wait()`. */
function statusReached(
  run: { onDidChangeStatus(l: (s: string) => void): () => void },
  status: string,
) {
  return new Promise<void>((resolve) => {
    const off = run.onDidChangeStatus((next) => {
      if (next === status) {
        off();
        resolve();
      }
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

  it("hands_the_caller_an_AuthenticationError_under_throwOnError", async () => {
    const fetchStub = stubFetch401();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", fetchStub);
    const agent = await Agent.create({
      apiKey: BAD_KEY,
      throwOnError: true,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const run = await agent.send("hi");
      const rejected = await run.wait().then(
        (result) => {
          throw new Error(`wait() resolved with status ${result.status}; expected a rejection`);
        },
        (error: unknown) => error,
      );

      // Precondition: the run reached the provider and failed on the 401.
      expect(fetchStub).toHaveBeenCalled();
      expect(rejected).toBeInstanceOf(TheokitAgentError);
      expect(rejected).toBeInstanceOf(AuthenticationError);
      expect(rejected).toBe((await readRunResolving(run)).error?.cause);
    } finally {
      await agent.dispose();
    }
  });

  it("resolves_a_cancelled_run_under_throwOnError", async () => {
    const fetchStub = stubFetchHanging();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", fetchStub);
    const agent = await Agent.create({
      apiKey: BAD_KEY,
      throwOnError: true,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const run = await agent.send("hi");
      await run.cancel();
      const result = await run.wait();

      expect(result.status).toBe("cancelled");
    } finally {
      await agent.dispose();
    }
  });

  it("fires_postRun_with_status_error_when_wait_is_not_called", async () => {
    const hookRun = vi.spyOn(HooksExecutor.prototype, "run");
    const fetchStub = stubFetch401();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", fetchStub);
    const agent = await Agent.create({
      apiKey: BAD_KEY,
      throwOnError: true,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    let postRunCalls: unknown[] = [];
    try {
      const run = await agent.send("hi");
      if (run.status !== "error") await statusReached(run, "error");
      expect(fetchStub).toHaveBeenCalled();
      // Returns after the lifecycle's mutex hold ends, so its postRun call has happened.
      await agent.dispose();
      postRunCalls = hookRun.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload.event === "postRun");
    } finally {
      await agent.dispose();
      hookRun.mockRestore();
    }
    expect(postRunCalls).toHaveLength(1);
    expect(postRunCalls[0]).toMatchObject({ event: "postRun", output: { status: "error" } });
  });
});

describe("a cloud run that the platform refuses", () => {
  // A cloud agent names no cwd, so its registry lands in process.cwd(); keep it out of the package.
  useTempCwd();
  let server: Server | undefined;

  beforeEach(async () => {
    clearAgentRegistry();
    invalidateRegistryHydration();
    server = createServer((req, res) => {
      if (req.url === "/v1/agents" && req.method === "POST") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            agentId: "bc-stub-throw",
            model: { id: "google/gemini-2.0-flash-001" },
          }),
        );
        return;
      }
      res.statusCode = 500;
      res.end("platform down");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("server bind failed");
    vi.stubEnv("THEOKIT_API_BASE_URL", `http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearAgentRegistry();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("cloud_send_rejects_under_throwOnError", async () => {
    const agent = await Agent.create({
      apiKey: "user-real-cloud-key",
      throwOnError: true,
      model: { id: "google/gemini-2.0-flash-001" },
      cloud: { repos: [{ url: "https://github.com/usetheo/example" }] },
    });
    try {
      const run = await agent.send("Run in the cloud");
      const rejected = await run.wait().then(
        (result) => {
          throw new Error(`wait() resolved with status ${result.status}; expected a rejection`);
        },
        (error: unknown) => error,
      );

      expect(rejected).toBeInstanceOf(TheokitAgentError);
      expect(rejected).toBe((await readRunResolving(run)).error?.cause);
    } finally {
      await agent.dispose();
    }
  });
});
