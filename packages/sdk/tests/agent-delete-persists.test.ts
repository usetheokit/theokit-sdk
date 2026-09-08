/**
 * #612, backported from the 5.x line (fixed there in `5.3.1`) — `Agent.delete` removes the entry
 * from the PERSISTED registry, not only from memory.
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
 * `flushRegistrySaves()` flushes an empty queue. The entry survives — and `Agent.delete` returns
 * normally, so a caller has no way to notice.
 *
 * Every CLI invocation is a fresh process, which is why this is reachable in ordinary use rather
 * than only under a restart. Found downstream as a `sessions delete` reporting success while the
 * session stayed listed, and as a consumer docblock promising a completed removal on the strength
 * of this method.
 *
 * ## Why the control is not decoration
 *
 * The neighbours work: `Agent.rename` and `Agent.archive` reach `getRegisteredAgentOrThrow`, which
 * hydrates on a miss. The first version of this test on the 5.x line failed on BOTH the case and
 * the control, because that helper hydrates `process.cwd()` by default and the fixture's agent
 * lived in a tmpdir. Without a control known to pass, a red bar here is indistinguishable from a
 * broken harness.
 *
 * ## `cwd` is part of the fix
 *
 * `AgentOperationOptions.cwd` already exists and was ignored (the parameter was `_options`).
 * Hydrating `process.cwd()` unconditionally would leave the delete broken for exactly the caller
 * that names a project other than the one it is running in.
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
 * Separate from `create` on purpose: the registry persists a SNAPSHOT of the in-memory entries for
 * a cwd, so clearing memory between two creates makes the second save erase the first. Every agent
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
