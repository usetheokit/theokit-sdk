/**
 * B-498 (AC-007): a run whose agent loop throws a non-SDK error records an `UnknownAgentError` at
 * `result.error.cause`, with the original error kept at `cause.cause`.
 *
 * In its own file because `vi.mock` is hoisted and replaces the loop module for the whole file.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../src/agent.js";
import { UnknownAgentError } from "../../src/errors.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../../src/internal/session/agent-session.js";

const loopFailure = new Error("loop exploded");

vi.mock("../../src/internal/agent-loop/loop.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/internal/agent-loop/loop.js")>();
  return {
    ...original,
    runAgentLoop: async () => {
      throw loopFailure;
    },
  };
});

describe("a run whose agent loop throws a plain Error", () => {
  let root: string;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-loop-foreign-cause-"));
  });

  afterEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("keeps_a_foreign_cause_under_the_UnknownAgentError", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const agent = await Agent.create({
      apiKey: `sk-or-v1-${"0".repeat(64)}`,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      const run = await agent.send("hi");
      const result = await run.wait();

      // Precondition: the failure came through RealLocalRun's outer catch.
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("agent_loop_failed");
      expect(result.error?.cause).toBeInstanceOf(UnknownAgentError);
      expect(result.error?.cause?.cause).toBe(loopFailure);
    } finally {
      await agent.dispose();
    }
  });
});
