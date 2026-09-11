import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { Skill as InlineSkillFactory } from "../src/create-skill.js";
import { SkillReadTool } from "../src/define-skill-read-tool.js";
import { discoverSkills } from "../src/internal/runtime/skills/discover-skills.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

/**
 * A skill discovered on disk was advertised to the model and could not be read by it.
 *
 * `skill_read` is the model's only door to a skill body, and `SkillReadTool.create` took
 * `ReadonlyArray<InlineSkill>` — the shape that carries `instructions` on the object. A
 * disk-discovered skill is a `Skill`, whose own declaration says "the skill BODY is never
 * included", so it did not fit through the door at all.
 *
 * The consequence is the whole on-disk surface: a `SKILL.md` is listed by name and description in
 * the `<skills>` block, the model asks to read it, and the instructions under the frontmatter — the
 * actual skill — have no path to arrive. Every other skill defect in this backlog is a field inside
 * a file whose body never showed up.
 *
 * The handler already returns `string | ToolResultContentBlock[] | Promise<…>`, so reading the body
 * when the model asks costs one `await` and no new contract. Reading it EAGERLY at construction
 * would be the other option and a worse one: it turns "this agent knows about twelve skills" into
 * twelve file reads at startup, to answer a question the model usually does not ask.
 */
function skillDirWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "theokit-skill-body-"));
  onTestFinished(() => {
    removeTempDirRobustSync(root);
  });
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const BODY = "Run `theo deploy --prod`, then watch the smoke test.";

describe("a discovered skill's body reaches the model", () => {
  it("returns the body when the model reads a disk-discovered skill", async () => {
    const root = skillDirWith({
      "deploy/SKILL.md": `---\nname: deploy\ndescription: Ship it\n---\n\n${BODY}\n`,
    });
    const tool = SkillReadTool.create(await discoverSkills(root));

    const out = await tool.handler({ name: "deploy" });

    expect(out, "the model was told the skill exists and could not read a word of it").toContain(
      BODY,
    );
  });

  it("includes the skill's references/ directory", async () => {
    const root = skillDirWith({
      "deploy/SKILL.md": `---\nname: deploy\ndescription: Ship it\n---\n\n${BODY}\n`,
      "deploy/references/rollback.md": "Run `theo rollback`.",
    });
    const tool = SkillReadTool.create(await discoverSkills(root));

    const out = await tool.handler({ name: "deploy" });

    // Inline skills already render their `references` in full, so a disk skill reading its
    // `references/` directory is symmetric with what ships, not a new appetite for context.
    expect(out).toContain("rollback.md");
    expect(out).toContain("Run `theo rollback`.");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal text a skill body contains, not an unescaped template literal
  it("resolves ${CLAUDE_SKILL_DIR} to the skill's own directory", async () => {
    // This is why skills are directories rather than single files: a skill ships scripts and
    // reference documents beside its `SKILL.md`, and the body has to be able to point at them.
    // Without the placeholder there is no expressible path — the skill does not know where it was
    // installed, and neither does its author at the time of writing.
    const root = skillDirWith({
      "deploy/SKILL.md":
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal text a skill body contains, not an unescaped template literal
        "---\nname: deploy\ndescription: Ship it\n---\n\nRun ${CLAUDE_SKILL_DIR}/scripts/go.sh\n",
    });
    const tool = SkillReadTool.create(await discoverSkills(root));

    const out = await tool.handler({ name: "deploy" });

    expect(out).toContain(`${join(root, "deploy")}/scripts/go.sh`);
    expect(out, "the placeholder survived into the prompt as literal text").not.toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal text a skill body contains, not an unescaped template literal
      "${CLAUDE_SKILL_DIR}",
    );
  });

  it("leaves the placeholder alone for an inline skill", async () => {
    // The control, and an honest limit rather than a guess. An inline skill has no directory —
    // nothing was installed anywhere — so substituting would have to invent a path. Leaving the
    // text as written says "this does not apply here"; inventing `/undefined/scripts` would not.
    const tool = SkillReadTool.create([
      InlineSkillFactory.create({
        name: "inline",
        description: "d",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal text a skill body contains, not an unescaped template literal
        instructions: "Run ${CLAUDE_SKILL_DIR}/go.sh",
      }),
    ]);
    expect(await Promise.resolve(tool.handler({ name: "inline" }))).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal text a skill body contains, not an unescaped template literal
      "${CLAUDE_SKILL_DIR}/go.sh",
    );
  });

  it("still reads an inline skill from the object", async () => {
    // The control. Inline skills carry `instructions`; a change that always went to disk would
    // break them, and they have no `source` to go to.
    const tool = SkillReadTool.create([
      InlineSkillFactory.create({ name: "inline", description: "d", instructions: "INLINE BODY" }),
    ]);
    expect(await tool.handler({ name: "inline" })).toContain("INLINE BODY");
  });

  it("still answers a name it does not have, without throwing", async () => {
    // The second control: an unknown name is a typed answer the model can act on, never a throw
    // that kills the run.
    const tool = SkillReadTool.create([
      InlineSkillFactory.create({ name: "inline", description: "d", instructions: "x" }),
    ]);
    // `Promise.resolve` because the handler may answer synchronously for an inline skill — the
    // contract is `string | Promise<string>`, and a control that demanded one of the two would be
    // pinning an implementation detail rather than the behaviour.
    expect(await Promise.resolve(tool.handler({ name: "absent" }))).toContain("not found");
  });
});
