import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { discoverSkills, type Skill } from "../src/internal/runtime/skills/discover-skills.js";
import { buildSkillsBlock } from "../src/internal/runtime/skills/skills-block.js";

const FIXTURE_SKILLS = join(__dirname, "fixtures/repos/project-with-skills/.theokit/skills");

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body, "utf8");
}

describe("buildSkillsBlock (M4-1)", () => {
  it("renders name and description as a <skills> block", () => {
    const block = buildSkillsBlock([{ name: "code-review", description: "Reviews diffs" }]);
    expect(block).toBe("<skills>\n  - code-review: Reviews diffs\n</skills>");
  });

  it("renders multiple skills, one line each", () => {
    const block = buildSkillsBlock([
      { name: "a", description: "first" },
      { name: "b", description: "second" },
    ]);
    expect(block).toBe("<skills>\n  - a: first\n  - b: second\n</skills>");
  });

  it("escapes injection chars in name and description", () => {
    const block = buildSkillsBlock([{ name: "x<y>", description: "a & b <c>" }]);
    expect(block).toContain("x&lt;y&gt;");
    expect(block).toContain("a &amp; b &lt;c&gt;");
    expect(block).not.toContain("<c>");
  });

  it("returns undefined for an empty list", () => {
    expect(buildSkillsBlock([])).toBeUndefined();
  });
});

describe("discoverSkills (M4-1)", () => {
  it("returns valid skills from an arbitrary dir", async () => {
    const skills = await discoverSkills(FIXTURE_SKILLS);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["code-review", "test-architect"]);
    const cr = skills.find((s) => s.name === "code-review") as Skill;
    expect(cr.description).toBe("Reviews TypeScript SDK changes for contract regressions.");
    expect(cr.source).toContain("code-review/SKILL.md");
  });

  it("skips an empty SKILL.md and reports missing_frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-empty-"));
    try {
      await writeSkill(root, "blank", "");
      const seen: Array<{ name?: string; code?: string }> = [];
      const skills = await discoverSkills(root, {
        onInvalidSkill: (info) => seen.push({ name: info.name, code: info.code }),
      });
      expect(skills).toEqual([]);
      expect(seen).toEqual([{ name: "blank", code: "missing_frontmatter" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips a malformed skill and calls onInvalidSkill with the typed code", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-malformed-"));
    try {
      await writeSkill(root, "good", "---\nname: good\ndescription: fine\n---\nbody");
      // Missing required `description` → schema_invalid
      await writeSkill(root, "bad", "---\nname: bad\n---\nbody");
      const seen: Array<{ name?: string; code?: string }> = [];
      const skills = await discoverSkills(root, {
        onInvalidSkill: (info) => seen.push({ name: info.name, code: info.code }),
      });
      expect(skills.map((s) => s.name)).toEqual(["good"]);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.code).toBe("schema_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns [] for a missing dir", async () => {
    const skills = await discoverSkills(join(tmpdir(), "does-not-exist-skills-xyz"));
    expect(skills).toEqual([]);
  });

  it("(EC-1) returns [] when the dir arg is a regular file, never throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-filepath-"));
    try {
      const filePath = join(root, "not-a-dir.txt");
      await writeFile(filePath, "i am a file", "utf8");
      await expect(discoverSkills(filePath)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("(EC-2) skips a subdir without SKILL.md and does NOT call onInvalidSkill", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-no-md-"));
    try {
      await writeSkill(root, "real", "---\nname: real\ndescription: ok\n---\nbody");
      await mkdir(join(root, "stray"), { recursive: true }); // no SKILL.md
      const seen: string[] = [];
      const skills = await discoverSkills(root, {
        onInvalidSkill: (info) => seen.push(info.name),
      });
      expect(skills.map((s) => s.name)).toEqual(["real"]);
      expect(seen).toEqual([]); // a skill-less dir is not a malformed skill
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips a subdir symlinked outside the root (symlink-escape guard)", async (ctx) => {
    const base = await mkdtemp(join(tmpdir(), "skills-symlink-"));
    try {
      const root = join(base, "skills");
      await mkdir(root, { recursive: true });
      await writeSkill(root, "real", "---\nname: real\ndescription: ok\n---\nbody");
      // an external skill dir outside the root
      const outside = join(base, "outside");
      await writeSkill(outside, "evil", "---\nname: evil\ndescription: escaped\n---\nbody");
      // symlink root/escape -> ../outside/evil (points outside root)
      try {
        await symlink(join(outside, "evil"), join(root, "escape"));
      } catch {
        // Platform without symlink permission: report SKIPPED, never PASS.
        ctx.skip("filesystem or platform refused symlink() creation");
      }
      const skills = await discoverSkills(root);
      expect(skills.map((s) => s.name)).toEqual(["real"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
