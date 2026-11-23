import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { Agent, Skill } from "../src/index.js";
import { explainSkills } from "../src/skills.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "explain-"));
  onTestFinished(() => removeTempDirRobustSync(d));
  return d;
}

function writeSkill(root: string, name: string, raw?: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    raw ?? `---\nname: ${name}\ndescription: d ${name}\n---\n\nBody.\n`,
  );
}

it("reports a shadowed duplicate with the .theokit root winning", async () => {
  const cwd = tmp();
  writeSkill(join(cwd, ".theokit/skills"), "dup");
  writeSkill(join(cwd, ".claude/skills"), "dup");
  const r = await explainSkills({
    cwd,
    settingSources: ["project"],
    compatSources: ["claude-code"],
  });
  expect(r.loaded).toHaveLength(1);
  expect(r.loaded[0]?.root).toBe(join(cwd, ".theokit/skills"));
  expect(r.shadowed).toEqual([
    {
      name: "dup",
      winner: join(cwd, ".theokit/skills/dup/SKILL.md"),
      loser: join(cwd, ".claude/skills/dup/SKILL.md"),
    },
  ]);
});

it("puts a SKILL.md without frontmatter in invalid, not loaded", async () => {
  const cwd = tmp();
  writeSkill(join(cwd, ".theokit/skills"), "bad", "no frontmatter here\n");
  const r = await explainSkills({ cwd, settingSources: ["project"] });
  expect(r.loaded).toEqual([]);
  expect(r.invalid.map((i) => i.code)).toEqual(["missing_frontmatter"]);
});

it("reports enabledButMissing and disabled", async () => {
  const cwd = tmp();
  writeSkill(join(cwd, ".theokit/skills"), "a");
  writeSkill(join(cwd, ".theokit/skills"), "b");
  const r = await explainSkills({
    cwd,
    settingSources: ["project"],
    skills: { enabled: ["a", "ghost"] },
  });
  expect(r.enabledButMissing).toEqual(["ghost"]);
  expect(r.disabled).toEqual(["b"]);
  expect(r.loaded.map((s) => s.name)).toEqual(["a"]);
});

it("loaded names equal agent.skills.list() names", async () => {
  const cwd = tmp();
  writeSkill(join(cwd, ".theokit/skills"), "a");
  writeSkill(join(cwd, ".claude/skills"), "a");
  writeSkill(join(cwd, ".claude/skills"), "c");
  const skills = { enabled: ["a", "c"] };
  const r = await explainSkills({
    cwd,
    skills,
    settingSources: ["project"],
    compatSources: ["claude-code"],
  });
  const agent = await Agent.create({
    apiKey: "test-key",
    model: { id: "composer-2" },
    local: { cwd, settingSources: ["project"], compatSources: ["claude-code"] },
    skills,
  });
  const listed = await agent.skills?.list();
  expect(r.loaded.map((s) => s.name).sort()).toEqual((listed ?? []).map((s) => s.name).sort());
  await agent[Symbol.asyncDispose]?.();
});

it("skillsDir replaces project roots and keeps bundled dirs", async () => {
  const cwd = tmp();
  const custom = join(tmp(), "custom");
  const bundled = join(tmp(), "bundled");
  writeSkill(join(cwd, ".theokit/skills"), "proj");
  writeSkill(custom, "x");
  const r = await explainSkills({
    cwd,
    settingSources: ["project"],
    skills: { skillsDir: custom, bundledDirs: [bundled] },
  });
  expect(r.roots).toEqual([
    { dir: custom, kind: "skillsDir" },
    { dir: bundled, kind: "bundled" },
  ]);
  expect(r.loaded.map((s) => s.name)).toEqual(["x"]);
});

it("inline override of a two-root duplicate reports inline as winner for each loser", async () => {
  const cwd = tmp();
  writeSkill(join(cwd, ".theokit/skills"), "dup");
  writeSkill(join(cwd, ".claude/skills"), "dup");
  const r = await explainSkills({
    cwd,
    settingSources: ["project"],
    compatSources: ["claude-code"],
    skills: { inline: [Skill.create({ name: "dup", description: "i", instructions: "x" })] },
  });
  expect(r.loaded).toEqual([{ name: "dup", source: "inline", root: "inline" }]);
  expect(r.shadowed).toEqual([
    { name: "dup", winner: "inline", loser: join(cwd, ".claude/skills/dup/SKILL.md") },
    { name: "dup", winner: "inline", loser: join(cwd, ".theokit/skills/dup/SKILL.md") },
  ]);
});

it("does not report an enabled-excluded inline-only skill as disabled", async () => {
  const cwd = tmp();
  writeSkill(join(cwd, ".theokit/skills"), "a");
  writeSkill(join(cwd, ".theokit/skills"), "b");
  const r = await explainSkills({
    cwd,
    settingSources: ["project"],
    skills: {
      enabled: ["a"],
      inline: [Skill.create({ name: "only-inline", description: "i", instructions: "x" })],
    },
  });
  expect(r.disabled).toEqual(["b"]);
  expect(r.loaded.map((s) => s.name)).toEqual(["a"]);
});
