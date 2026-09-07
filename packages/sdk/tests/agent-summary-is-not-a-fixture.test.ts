/**
 * #611 — a local agent's public `summary` is not the name of a test fixture.
 *
 * ## The defect
 *
 * `registerLocalAgent` assigned `summary: "Local contract fixture"` unconditionally, so that string
 * was the ONLY value `SDKAgentInfo.summary` could ever hold for a local agent. The field is
 * `@public` and non-optional (`types/agent.ts`), returned by `Agent.list()` and `Agent.get()`, and
 * `AgentOptions` exposes no `summary` — so a consumer could neither change it nor avoid it. It was
 * measured reaching a real user's session record on disk, through a consumer, from a real turn.
 *
 * ## Why the cloud sibling is the control, and why this is an omission rather than a choice
 *
 * `cloud-agent.ts` faces the same requirement and guards it:
 *
 * ```ts
 * summary: this.isFixtureMode() ? "Cloud contract fixture" : "Cloud agent",
 * ```
 *
 * Same concern, same `registerAgent` call, two runtimes — one distinguishes a fixture from a real
 * agent and the other could not. `isFixtureMode()` keys off a `theo_test_*` key with no configured
 * base URL, which is a CLOUD notion (it describes whether the remote is stubbed). There is no local
 * equivalent to port, and inventing one would be adding a concept to justify a string. So the local
 * branch takes the cloud branch's non-fixture value and stops naming real data after a fixture.
 *
 * ## The assertion is on the property, not the literal
 *
 * `not.toMatch(/fixture/i)` rather than `toBe("Local agent")`. A test pinned to the new literal
 * passes while a third site goes on emitting the old one, which is the failure mode this had in the
 * first place: two sites (`local-agent-bootstrap.ts` and the `helpers.ts` fallback) carried the same
 * string and neither knew about the other. What must hold is that no fixture name reaches a
 * consumer, and that is what is written down here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../src/index.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../src/internal/runtime/registry/agent-registry.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "issue611-"));
  clearAgentRegistry();
});

afterEach(() => {
  clearAgentRegistry();
  invalidateRegistryHydration();
  rmSync(cwd, { recursive: true, force: true });
});

async function createLocalAgent(): Promise<string> {
  const agent = await Agent.create({
    apiKey: "theo_test_issue_611",
    model: { id: "google/gemini-2.0-flash-001" },
    local: { cwd },
  });
  const id = agent.agentId;
  await agent.dispose();
  return id;
}

describe("a local agent's public summary", () => {
  it("is not the name of a test fixture, through Agent.list", async () => {
    const id = await createLocalAgent();
    const listed = (await Agent.list({ runtime: "local", cwd })).items.find(
      (i) => i.agentId === id,
    );
    expect(listed?.summary).toBeDefined();
    expect(listed?.summary).not.toMatch(/fixture/i);
  });

  it("is not the name of a test fixture, through Agent.get", async () => {
    const id = await createLocalAgent();
    const got = await Agent.get(id);
    expect(got.summary).not.toMatch(/fixture/i);
  });

  /**
   * The fallback in `toLocalAgentInfo` carried the same literal, and while the registration wrote
   * it too the fallback could never be observed — a record with no `summary` is the only input that
   * reaches it. Registering one directly is what makes the second site testable at all.
   */
  it("is not the name of a test fixture when the stored record has none", async () => {
    const { registerAgent } = await import("../src/internal/runtime/registry/agent-registry.js");
    registerAgent({
      agentId: "agent-no-summary-611",
      runtime: "local",
      createdAt: 1,
      lastModified: 1,
      archived: false,
      options: {},
      cwd,
    });
    const listed = (await Agent.list({ runtime: "local", cwd })).items.find(
      (i) => i.agentId === "agent-no-summary-611",
    );
    expect(listed?.summary).not.toMatch(/fixture/i);
  });
});
