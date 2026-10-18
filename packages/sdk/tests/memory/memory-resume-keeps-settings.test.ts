import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, ConfigurationError } from "../../src/index.js";
import { LocalAgent } from "../../src/internal/local-agent/local-agent.js";
import { persistMemoryFactIfWritePrompt } from "../../src/internal/local-agent/local-agent-runtime-extensions.js";
import { appendFactToMarkdown } from "../../src/internal/memory/storage/markdown-store.js";
import { projectMemoryDir } from "../../src/internal/memory/storage/memory-root.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import type { MemorySettings } from "../../src/types/agent.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

/*
 * B-380 review round 2 (F-arch-19, F-dom-5, loop-code-review #8). The changeset says a resumed
 * agent keeps its memory ceiling. It did only when resume was given no memory override:
 * `Agent.resume(id, { memory: { enabled: true } })` replaced the persisted memory settings whole
 * and came back with no ceiling. And `memory.directory` was never persisted, so even a resume with
 * no override counted the default store instead of the one the agent was created with.
 *
 * Each test simulates a restart (in-memory registry cleared, registry.json kept), so what is
 * asserted is what survives on disk, not what one process remembered.
 */

let cwd: string;
let directory: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "theokit-resume-memory-"));
  directory = join(cwd, "agent-memory");
  clearAgentRegistry();
  invalidateRegistryHydration();
});

afterEach(async () => {
  clearAgentRegistry();
  invalidateRegistryHydration();
  await removeTempDirRobust(cwd);
});

async function createThenRestart(memory: MemorySettings): Promise<string> {
  const agent = await Agent.create({
    apiKey: "theo_test_fixture_key",
    model: { id: "google/gemini-2.0-flash-001" },
    local: { cwd },
    memory,
  });
  await agent.dispose();
  clearAgentRegistry();
  invalidateRegistryHydration();
  return agent.agentId;
}

async function resumedMemory(
  agentId: string,
  memory?: MemorySettings,
): Promise<MemorySettings | undefined> {
  const resumed = await Agent.resume(agentId, {
    local: { cwd },
    ...(memory !== undefined ? { memory } : {}),
  });
  await resumed.dispose();
  expect(resumed).toBeInstanceOf(LocalAgent);
  return (resumed as LocalAgent).options.memory;
}

async function persistedMemory(agentId: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readFile(join(cwd, ".theokit", "agents", "registry.json"), "utf8");
  const registry = JSON.parse(raw) as {
    data: Record<string, { options: { memory?: Record<string, unknown> } }>;
  };
  return registry.data[agentId]?.options.memory;
}

async function factFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((e) => e.endsWith(".md") && e !== "MEMORY.md");
}

describe("a resumed agent keeps its memory settings", () => {
  it("keeps the declared directory across a restart", async () => {
    const id = await createThenRestart({ enabled: true, directory, maxFacts: 3 });

    expect((await resumedMemory(id))?.directory).toBe(directory);
  });

  it("keeps the persisted ceiling and directory when resume overrides another memory field", async () => {
    const id = await createThenRestart({ enabled: true, directory, maxFacts: 3 });

    const memory = await resumedMemory(id, { enabled: true });

    expect(memory?.maxFacts, "the override did not name maxFacts").toBe(3);
    expect(memory?.directory, "the override did not name directory").toBe(directory);
    expect(await persistedMemory(id)).toMatchObject({ maxFacts: 3, directory });
  });

  it("keeps the persisted ceiling when the override sets maxFacts to undefined", async () => {
    const id = await createThenRestart({ enabled: true, directory, maxFacts: 3 });

    expect((await resumedMemory(id, { enabled: true, maxFacts: undefined }))?.maxFacts).toBe(3);
  });

  it("refuses a fact past the ceiling in the declared directory after a resume", async () => {
    const id = await createThenRestart({ enabled: true, directory, maxFacts: 3 });
    for (const text of [
      "the alpha job runs daily",
      "the beta job runs weekly",
      "the gamma job runs hourly",
    ]) {
      await appendFactToMarkdown(cwd, { text }, directory);
    }

    const memory = await resumedMemory(id, { enabled: true });
    await persistMemoryFactIfWritePrompt(cwd, memory, "Remember: the delta job runs monthly");

    expect(await factFiles(directory), "the declared directory stays at its ceiling").toHaveLength(
      3,
    );
    expect(
      await factFiles(projectMemoryDir(cwd)),
      "the fact did not land in the default store either",
    ).toHaveLength(0);
  });

  it("lets a resume override replace the ceiling it names", async () => {
    const id = await createThenRestart({ enabled: true, directory, maxFacts: 3 });

    expect((await resumedMemory(id, { enabled: true, maxFacts: 7 }))?.maxFacts).toBe(7);
  });

  it("still refuses an invalid ceiling passed with a partial memory override", async () => {
    const id = await createThenRestart({ enabled: true, directory, maxFacts: 3 });

    const refusal = await Agent.resume(id, {
      local: { cwd },
      memory: { enabled: true, maxFacts: 0 },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(refusal).toBeInstanceOf(ConfigurationError);
    expect((refusal as ConfigurationError).code).toBe("invalid_memory_ceiling");
  });
});
