import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Agent } from "../../../src/index.js";
import { parseSkillFrontmatter } from "../../../src/internal/runtime/skills/skill-frontmatter.js";
import { removeTempDirRobust } from "../../helpers/temp-workspace.js";

/**
 * ADR D10 + EC-5 — strict frontmatter schema for skills, malformed YAML
 * surfaces as schema_invalid (not a crash).
 */

describe("parseSkillFrontmatter — strict schema (ADR D10)", () => {
  it("accepts a full frontmatter (all 4 fields)", () => {
    const md = [
      "---",
      "name: deploy",
      "description: Ships to prod",
      "category: ops",
      "dependencies: bash, docker",
      "---",
      "",
      "body",
    ].join("\n");
    const result = parseSkillFrontmatter(md, "deploy-fallback");
    expect(result).toEqual({
      name: "deploy",
      description: "Ships to prod",
      category: "ops",
      dependencies: ["bash", "docker"],
    });
  });

  it("accepts minimum frontmatter (name + description only)", () => {
    const md = ["---", "name: small", "description: minimum viable", "---", ""].join("\n");
    const result = parseSkillFrontmatter(md, "small-fallback");
    expect(result.name).toBe("small");
    expect(result.description).toBe("minimum viable");
    expect(result.category).toBeUndefined();
    expect(result.dependencies).toBeUndefined();
  });

  it("falls back to dir name when frontmatter omits `name`", () => {
    const md = ["---", "description: anonymous", "---", ""].join("\n");
    const result = parseSkillFrontmatter(md, "my-dir-name");
    expect(result.name).toBe("my-dir-name");
  });

  it("rejects missing description with schema_invalid", () => {
    const md = ["---", "name: nope", "---", ""].join("\n");
    expect(() => parseSkillFrontmatter(md, "nope")).toThrow(
      expect.objectContaining({ code: "schema_invalid" }),
    );
  });

  it("rejects missing frontmatter with missing_frontmatter", () => {
    const md = "# just a body, no frontmatter\n";
    expect(() => parseSkillFrontmatter(md, "nope")).toThrow(
      expect.objectContaining({ code: "missing_frontmatter" }),
    );
  });
});

describe("SkillsManager — broken skills are skipped, not fatal (EC-5)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-skills-strict-"));
    const __cwdCleanup1 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup1);
    });
  });

  it("logs and excludes a malformed skill; the good skill remains listed", async () => {
    const good = join(cwd, ".theokit", "skills", "good");
    const bad = join(cwd, ".theokit", "skills", "bad");
    await mkdir(good, { recursive: true });
    await mkdir(bad, { recursive: true });
    await writeFile(
      join(good, "SKILL.md"),
      ["---", "name: good", "description: this one works", "---", "", "body"].join("\n"),
      "utf8",
    );
    // `bad` has frontmatter but no description — schema_invalid
    await writeFile(
      join(bad, "SKILL.md"),
      ["---", "name: bad", "---", "", "body"].join("\n"),
      "utf8",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const agent = await Agent.create({
      apiKey: "theo_test_skills_strict",
      model: { id: "google/gemini-2.0-flash-001" },
      local: { cwd, settingSources: ["project"] },
    });
    const agentWithSkills = agent as unknown as {
      skills?: {
        list: () => Promise<Array<{ name: string }>>;
        get: (
          name: string,
        ) => Promise<{ name: string; description: string; instructions: string } | undefined>;
      };
    };
    const skills = (await agentWithSkills.skills?.list()) ?? [];

    expect(skills.map((s) => s.name).sort()).toEqual(["good"]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("bad skipped (schema_invalid)"));

    stderrSpy.mockRestore();
    await agent.dispose?.();
  });

  it("skill without frontmatter is skipped with missing_frontmatter code", async () => {
    const noFm = join(cwd, ".theokit", "skills", "no-fm");
    await mkdir(noFm, { recursive: true });
    await writeFile(join(noFm, "SKILL.md"), "# body without frontmatter\n", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const agent = await Agent.create({
      apiKey: "theo_test_skills_no_fm",
      model: { id: "google/gemini-2.0-flash-001" },
      local: { cwd, settingSources: ["project"] },
    });
    const agentWithSkills = agent as unknown as {
      skills?: {
        list: () => Promise<Array<{ name: string }>>;
        get: (
          name: string,
        ) => Promise<{ name: string; description: string; instructions: string } | undefined>;
      };
    };
    const skills = (await agentWithSkills.skills?.list()) ?? [];

    expect(skills).toEqual([]);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("no-fm skipped (missing_frontmatter)"),
    );

    stderrSpy.mockRestore();
    await agent.dispose?.();
  });
});
