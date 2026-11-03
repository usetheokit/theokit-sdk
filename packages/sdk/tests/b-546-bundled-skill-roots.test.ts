import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { SkillReadTool } from "../src/define-skill-read-tool.js";
import { bootstrapSubmanagers } from "../src/internal/local-agent/local-agent-bootstrap.js";
import { SkillsManager } from "../src/internal/runtime/skills/skills-manager.js";
import type { LocalAssemblyInputs } from "../src/internal/runtime/system-prompt/local-assembly.js";
import {
  assembleSystemPromptForSend,
  buildSystemPromptContext,
} from "../src/internal/runtime/system-prompt/local-assembly.js";
import { SystemPromptPipeline } from "../src/internal/runtime/system-prompt/pipeline.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

/**
 * B-546: an application that ships skills inside its own package needs a root BELOW the workspace,
 * a way to hide a skill whose binary is not installed, and a reader that sees skills discovered
 * after the agent was created.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  return dir;
}

function writeSkill(root: string, name: string, description: string, extra = ""): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name} (${description}).\n`,
  );
}

async function offered(manager: SkillsManager): Promise<Array<[string, string]>> {
  const inputs = { agentId: "a", workspaceCwd: "/tmp", model: undefined } as LocalAssemblyInputs;
  const ctx = await buildSystemPromptContext(inputs, "hi", [], manager);
  return ctx.skills.map((s) => [s.name, s.description]);
}

describe("B-546 bundled skill roots", () => {
  it("lists a bundled-root skill after a project skill of the same name, and the project wins", async () => {
    const cwd = tempDir("b546-cwd-");
    const bundled = tempDir("b546-bundled-");
    writeSkill(join(cwd, ".theokit", "skills"), "deploy", "project version");
    writeSkill(bundled, "deploy", "bundled version");
    writeSkill(bundled, "extra", "bundled only");

    const manager = new SkillsManager(cwd, undefined, true, undefined, undefined, [], [bundled]);
    await manager.initialize();
    const listed = await manager.list();

    expect(listed.find((s) => s.name === "deploy")?.description).toBe("project version");
    expect(listed.map((s) => s.name)).toEqual(["deploy", "extra"]);
  });
});

describe("B-546 binary gating", () => {
  it("hides a skill whose binary is absent from PATH and offers it once present", async () => {
    const skills = tempDir("b546-skills-");
    const bin = tempDir("b546-bin-");
    const exe = "b546-needed-tool";
    writeSkill(skills, "needs-tool", "needs a binary", `requires-bins: ${exe}\n`);
    writeSkill(skills, "plain", "needs nothing");
    const manager = new SkillsManager(skills, undefined, true, skills);
    await manager.initialize();

    const saved = process.env.PATH;
    onTestFinished(() => {
      process.env.PATH = saved;
    });
    process.env.PATH = [bin, saved].filter(Boolean).join(delimiter);

    expect((await offered(manager)).map(([n]) => n)).toEqual(["plain"]);

    const file = join(bin, process.platform === "win32" ? `${exe}.cmd` : exe);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);

    expect((await offered(manager)).map(([n]) => n).sort()).toEqual(["needs-tool", "plain"]);
  });
});

describe("B-546 lazy skill reader", () => {
  it("returns the instructions of a skill discovered after the reader was created", async () => {
    const skills = tempDir("b546-late-");
    const manager = new SkillsManager(skills, undefined, true, skills);
    await manager.initialize();
    const tool = SkillReadTool.create(() => manager.list());

    writeSkill(skills, "late", "arrived later");
    await manager.refresh();

    const out = await tool.handler({ name: "late" });
    expect(out).toContain("Body of late (arrived later).");
  });
});

describe("B-546 bundled roots through the public option", () => {
  it("lists a bundled skill from SkillsSettings.bundledDirs when project setting sources are off", async () => {
    const ws = tempDir("b546-ws-");
    const bundled = tempDir("b546-pub-bundled-");
    writeSkill(bundled, "shipped", "ships with the app");

    const sub = bootstrapSubmanagers({
      options: { skills: { bundledDirs: [bundled] } },
      workspaceCwd: ws,
      settingSourcesIncludeProject: false,
      settingSourcesIncludePlugins: false,
    } as unknown as Parameters<typeof bootstrapSubmanagers>[0]);
    await sub.skillsManager?.initialize();

    expect((await sub.skills?.list())?.map((s) => s.name)).toEqual(["shipped"]);
  });

  it("hands bundledDirs from a per-send resolver to the manager it builds", async () => {
    const bundled = tempDir("b546-resolver-bundled-");
    writeSkill(bundled, "from-resolver", "bundled via resolver");
    const inputs = {
      agentId: "a",
      workspaceCwd: tempDir("b546-resolver-ws-"),
      model: undefined,
      options: { skills: () => ({ bundledDirs: [bundled] }) },
      settingSourcesIncludeProject: false,
      systemPromptPipeline: SystemPromptPipeline.default(),
    } as unknown as LocalAssemblyInputs;

    const prompt = await assembleSystemPromptForSend({
      inputs,
      userText: "hi",
      baseSystemPrompt: undefined,
      memoryFacts: [],
      activeMemorySummary: undefined,
    });

    expect(prompt).toContain("from-resolver");
  });
});
