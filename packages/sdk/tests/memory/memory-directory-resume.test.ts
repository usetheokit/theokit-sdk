import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../src/index.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";

describe("a resumed agent keeps memory.directory", () => {
  let cwd: string;
  let memDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-memdir-cwd-"));
    memDir = await mkdtemp(join(tmpdir(), "theokit-memdir-mem-"));
    clearAgentRegistry();
    invalidateRegistryHydration();
  });

  afterEach(async () => {
    clearAgentRegistry();
    invalidateRegistryHydration();
    await rm(cwd, { recursive: true, force: true });
    await rm(memDir, { recursive: true, force: true });
  });

  it("writes a Remember: fact into the declared directory, not <cwd>/.theokit/memory", async () => {
    const memory = { enabled: true, namespace: "ns", scope: "user" as const, userId: "u" };
    const a = await Agent.create({
      agentId: "agent-memdir-resume",
      apiKey: "theo_test_memdir",
      model: { id: "google/gemini-2.0-flash-001" },
      local: { cwd },
      memory: { ...memory, directory: memDir },
    });
    await a.dispose();
    clearAgentRegistry();
    invalidateRegistryHydration();

    const resumed = await Agent.resume("agent-memdir-resume", { local: { cwd } });
    try {
      const run = await resumed.send("Remember: the sky is blue");
      await run.wait();
    } finally {
      await resumed.dispose();
    }
    expect((await readdir(memDir, { recursive: true })).length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, ".theokit", "memory"))).toBe(false);
  });
});
