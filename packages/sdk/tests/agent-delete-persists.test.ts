/**
 * #612 — `Agent.delete` removes the entry from the PERSISTED registry, not only from memory.
 *
 * ## The defect
 *
 * ```ts
 * static async delete(agentId: string, _options: AgentOperationOptions = {}): Promise<void> {
 *   removeRegisteredAgent(agentId);
 *   await flushRegistrySaves();
 * }
 * ```
 *
 * `removeRegisteredAgent` only schedules a save when the entry was in the in-memory Map. In a fresh
 * process the Map is empty, so `agents.delete()` returns `false`, nothing is scheduled, and
 * `flushRegistrySaves()` flushes an empty queue. The persisted entry survives — and `Agent.delete`
 * returns normally, so a caller has no way to notice.
 *
 * Every CLI invocation is a fresh process, which is why this was reachable in ordinary use rather
 * than only under a restart: measured downstream as `sessions delete` reporting success while the
 * session stayed listed.
 *
 * ## What made it hard to see
 *
 * The neighbours work. `Agent.rename` and `Agent.archive` go through `getRegisteredAgentOrThrow`,
 * which hydrates from disk on a miss; `Agent.delete` was the only mutator that never hydrated. The
 * `?.` on the loop's plugin call is NOT the swallow point either — `pluginManagerCode` is
 * constructed unconditionally. It is purely the missing hydration.
 *
 * The `rename` control below exists for that reason and is not decoration: the first version of this
 * test failed on BOTH cases, because `getRegisteredAgentOrThrow` hydrates `process.cwd()` by default
 * and the fixture's agent lived in a tmpdir. Without a control that is known to pass, a red bar here
 * is indistinguishable from a broken harness.
 *
 * ## `cwd` is part of the fix, not a nicety
 *
 * `AgentOperationOptions.cwd` already exists and was ignored here (the parameter was `_options`).
 * Hydrating `process.cwd()` unconditionally would repeat B-115 — a documented option that compiles
 * and does nothing — and would leave the delete broken for exactly the caller that names a project
 * other than the one it is running in.
 *
 * ## What this test deliberately does NOT assert
 *
 * That deleting an unknown id throws. `Agent.rename` throws `UnknownAgentError`, and matching it
 * here would be defensible — but it is a breaking change for callers that delete idempotently, and a
 * registry entry and its transcript can legitimately outlive one another in both directions. Fixing
 * persistence should not smuggle in an API break; that decision belongs to its own change.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../src/index.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../src/internal/runtime/registry/agent-registry.js";
import { useTempCwd } from "./helpers/temp-workspace.js";
import { withMockedCwd } from "./helpers/with-cwd.js";

useTempCwd();

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "issue612-"));
  clearAgentRegistry();
});

afterEach(() => {
  clearAgentRegistry();
  invalidateRegistryHydration();
  rmSync(cwd, { recursive: true, force: true });
});

function persisted(): Record<string, unknown> {
  const raw = readFileSync(join(cwd, ".theokit", "agents", "registry.json"), "utf8");
  return (JSON.parse(raw) as { data: Record<string, unknown> }).data;
}

async function create(): Promise<string> {
  const agent = await Agent.create({
    apiKey: "theo_test_issue_612",
    model: { id: "google/gemini-2.0-flash-001" },
    local: { cwd },
  });
  const id = agent.agentId;
  await agent.dispose();
  return id;
}

/**
 * Drop every trace from memory — a fresh process, in one test.
 *
 * Separate from `create` on purpose. The registry persists a SNAPSHOT of the in-memory entries for a
 * cwd, so clearing memory between two creates makes the second save erase the first — which failed
 * the multi-entry case below for a fixture reason that has nothing to do with `delete`. Every agent
 * a test wants on disk has to be created before the restart is simulated.
 */
function simulateRestart(): void {
  clearAgentRegistry();
  invalidateRegistryHydration();
}

async function createThenSimulateRestart(): Promise<string> {
  const id = await create();
  simulateRestart();
  return id;
}

describe("Agent.delete", () => {
  it("CONTROL: Agent.rename persists across a simulated restart", async () => {
    const id = await createThenSimulateRestart();
    await withMockedCwd(cwd, () => Agent.rename(id, "renamed-by-control"));
    expect((persisted()[id] as { name?: string }).name).toBe("renamed-by-control");
  });

  it("removes the entry from the persisted registry", async () => {
    const id = await createThenSimulateRestart();
    await withMockedCwd(cwd, () => Agent.delete(id));
    expect(Object.keys(persisted())).not.toContain(id);
  });

  it("honours options.cwd, so it can delete from a project it is not running in", async () => {
    const id = await createThenSimulateRestart();
    // process.cwd() is the suite's temp workspace, NOT `cwd` — only the option can find the entry.
    await Agent.delete(id, { cwd });
    expect(Object.keys(persisted())).not.toContain(id);
  });

  it("leaves the other entries in the project alone", async () => {
    const keep = await create();
    const drop = await create();
    simulateRestart();
    await Agent.delete(drop, { cwd });
    const after = Object.keys(persisted());
    expect(after).not.toContain(drop);
    expect(after).toContain(keep);
  });
});
