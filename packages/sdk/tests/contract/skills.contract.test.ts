import { afterEach, describe, expect, it } from "vitest";

import { Agent, type AgentOptions, type SDKAgent } from "../../src/index.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/temp-workspace.js";

describe("skills contract", () => {
  let workspace: TempWorkspace | undefined;
  let agent: ProposedSDKAgent | undefined;

  afterEach(async () => {
    // Dispose the agent BEFORE removing the workspace so its async session-summary / registry
    // writes (fire-and-forget after a run) never race the directory removal — the ENOTEMPTY /
    // ENOENT-on-rename flakiness this suite used to emit. Each test assigns the shared `agent`.
    await agent?.dispose();
    agent = undefined;
    await workspace?.cleanup();
    workspace = undefined;
  });

  it("loads file-based skills and makes them visible to runs without leaking full prompt bodies", async () => {
    workspace = await createTempWorkspace("project-with-skills");
    const options: ProposedAgentOptions = {
      apiKey: "theo_test_contract_key",
      model: { id: "google/gemini-2.0-flash-001" },
      local: { cwd: workspace.cwd, settingSources: ["project"] },
      skills: {
        enabled: ["code-review", "test-architect"],
      },
    };
    agent = (await Agent.create(options)) as ProposedSDKAgent;

    const skills = await agent.skills.list();
    const run = await agent.send("Use the code-review skill to review this SDK contract.");
    const events = [];
    for await (const event of run.stream()) events.push(event);

    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "code-review",
          description: expect.stringMatching(/Reviews TypeScript/),
        }),
        expect.objectContaining({
          name: "test-architect",
          description: expect.stringMatching(/red-first/),
        }),
      ]),
    );
    expect(JSON.stringify(events)).toContain("code-review");
    expect(JSON.stringify(events)).not.toContain(
      "Check public API compatibility, runtime behavior",
    );
  });

  it("agent.skills.get(name) returns a filesystem skill's full body (SE20)", async () => {
    workspace = await createTempWorkspace("project-with-skills");
    const options: ProposedAgentOptions = {
      apiKey: "theo_test_contract_key",
      model: { id: "google/gemini-2.0-flash-001" },
      local: { cwd: workspace.cwd, settingSources: ["project"] },
      skills: { enabled: ["code-review"] },
    };
    agent = (await Agent.create(options)) as ProposedSDKAgent;

    const detail = await agent.skills.get("code-review");
    expect(detail?.name).toBe("code-review");
    // The body `list()` deliberately hides from the block is available via `get`.
    expect(detail?.instructions).toContain("Check public API compatibility, runtime behavior");
    expect(detail?.instructions).not.toContain("---"); // frontmatter stripped
    // A filesystem skill carries no inline `references` (SE21) — the field stays absent.
    expect(detail?.references).toBeUndefined();

    await expect(agent.skills.get("no-such-skill")).resolves.toBeUndefined();
  });

  it("reload picks up new skills and SKIPS malformed skill frontmatter (graceful-degrade, EC-5)", async () => {
    workspace = await createTempWorkspace("project-with-skills");
    const options: ProposedAgentOptions = {
      apiKey: "theo_test_contract_key",
      model: { id: "google/gemini-2.0-flash-001" },
      local: { cwd: workspace.cwd, settingSources: ["project"] },
      skills: { enabled: ["code-review", "security"] },
    };
    agent = (await Agent.create(options)) as ProposedSDKAgent;

    await workspace.writeText(
      ".theokit/skills/security/SKILL.md",
      "---\nname: security\ndescription: Security reviewer.\n---\n\nCheck secret handling.",
    );
    await agent.reload();
    await expect(agent.skills.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "security" })]),
    );

    // A malformed skill (missing `description`) is SKIPPED with a stderr warning — reload does NOT
    // throw (strict-frontmatter ADR / EC-5: a broken skill never blocks the agent; it is just
    // excluded from `list()`). The previously-loaded valid skills remain visible. (afterEach disposes
    // the agent before the workspace is removed, so no async write races the cleanup.)
    await workspace.writeText(
      ".theokit/skills/bad/SKILL.md",
      "---\nname: bad\n---\n\nMissing description.",
    );
    await expect(agent.reload()).resolves.toBeUndefined();
    const names = (await agent.skills.list()).map((s) => s.name);
    expect(names).toContain("security");
    expect(names).not.toContain("bad");
  });
});

type ProposedAgentOptions = AgentOptions & {
  skills?: {
    enabled?: string[];
    paths?: string[];
  };
};

type ProposedSDKAgent = SDKAgent & {
  skills: {
    list(): Promise<Array<{ name: string; description: string }>>;
    get(name: string): Promise<
      | {
          name: string;
          description: string;
          instructions: string;
          references?: Record<string, string>;
        }
      | undefined
    >;
  };
};
