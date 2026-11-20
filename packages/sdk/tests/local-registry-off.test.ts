import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, ConfigurationError, InMemorySessionStore } from "../src/index.js";
import {
  clearAgentRegistry,
  flushRegistrySaves,
  listRegisteredAgents,
  registerAgent,
  removeRegisteredAgent,
  updateRegisteredAgent,
} from "../src/internal/runtime/registry/agent-registry.js";
import { loadRegistry } from "../src/internal/runtime/registry/agent-registry-store.js";
import { removeTempDirRobust } from "./helpers/temp-workspace.js";

const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  clearAgentRegistry();
  for (const d of dirs.splice(0)) await removeTempDirRobust(d);
});

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.map(String).sort();
}

describe("local.registry: false", () => {
  it("leaves nothing on disk in cwd or HOME after a turn and dispose", async () => {
    const cwd = await tmp("theokit-1043-cwd-");
    const home = await tmp("theokit-1043-home-");
    const agent = await Agent.create({
      apiKey: "theo_test_1043",
      model: { id: "claude-sonnet-4-6" },
      memory: { enabled: false },
      local: { cwd, sessionDir: home, sessionStore: new InMemorySessionStore(), registry: false },
    });
    await (await agent.send("hello")).wait();
    await agent.dispose();
    await flushRegistrySaves();
    expect(await walk(cwd)).toEqual([]);
    expect(await walk(home)).toEqual([]);
  });

  it("refuses a non-boolean local.registry naming the option", async () => {
    await expect(
      Agent.create({
        apiKey: "theo_test_1043",
        model: { id: "claude-sonnet-4-6" },
        local: { registry: "no" as unknown as boolean },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConfigurationError && e.message.includes("local.registry"),
    );
  });

  it("stays listed in-process but never reaches a persisted snapshot", async () => {
    const cwd = await tmp("theokit-1043-reg-");
    const base = {
      runtime: "local" as const,
      summary: "s",
      createdAt: 1,
      lastModified: 1,
      archived: false,
      cwd,
      status: "finished" as const,
    };
    const model = { id: "claude-sonnet-4-6" };
    registerAgent({ ...base, agentId: "hidden", options: { model, local: { registry: false } } });
    registerAgent({ ...base, agentId: "shown", options: { model, local: {} } });
    updateRegisteredAgent("hidden", { summary: "changed" });
    await flushRegistrySaves();
    expect(
      listRegisteredAgents("local", cwd)
        .map((a) => a.agentId)
        .sort(),
    ).toEqual(["hidden", "shown"]);
    expect(Object.keys(await loadRegistry(cwd))).toEqual(["shown"]);
    removeRegisteredAgent("hidden");
    await flushRegistrySaves();
    expect(Object.keys(await loadRegistry(cwd))).toEqual(["shown"]);
  });
});
