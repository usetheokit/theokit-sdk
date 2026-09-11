import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { SkillsManager } from "../../../../src/internal/runtime/skills/skills-manager.js";
import type { LocalAssemblyInputs } from "../../../../src/internal/runtime/system-prompt/local-assembly.js";
import { buildSystemPromptContext } from "../../../../src/internal/runtime/system-prompt/local-assembly.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * The scaffold writes an authorization declaration and the runtime discards it.
 *
 * `create-theokit` generates seven skills carrying `user-invocable: false`, and `buildFrontmatter`
 * keeps exactly `name`, `description`, `category` and `dependencies`. The key survives the YAML
 * parser and is dropped one function later, so the template declares a restriction the runtime
 * cannot honour — and the default is disclose-all.
 *
 * Two fields, two different surfaces, and the difference is the whole design:
 *
 *   - `disable-model-invocation: true` — the SDK OWNS this boundary. The model learns a skill
 *     exists from exactly one place, `buildSystemPromptContext`, so honouring it is a filter there.
 *     This is the capability the spec names when it says "You don't want Claude deciding to deploy
 *     because your code looks ready": a side-effecting skill the model may not fire on its own.
 *   - `user-invocable: false` — the SDK owns NO user surface for skills. There is no slash command
 *     here. Inventing one boundary out of `agent.skills.list()` would be guessing at semantics, so
 *     the field is CARRIED to the host that does have a picker, rather than enforced by a layer
 *     that cannot tell a picker from an introspection call.
 *
 * Both remain resolvable by name through `get()`. An explicit invocation by name is neither of the
 * two enumerations, and refusing it would turn a disclosure rule into an execution rule.
 */
function skillsDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-skill-auth-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  for (const [name, frontmatter] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody of ${name}.\n`);
  }
  return dir;
}

async function managerOver(dir: string): Promise<SkillsManager> {
  const manager = new SkillsManager(dir, undefined, true, dir);
  await manager.initialize();
  return manager;
}

async function modelVisible(manager: SkillsManager): Promise<string[]> {
  const inputs = { agentId: "a", workspaceCwd: "/tmp", model: undefined } as LocalAssemblyInputs;
  const ctx = await buildSystemPromptContext(inputs, "hi", [], manager);
  return ctx.skills.map((s) => s.name);
}

describe("an authorization declaration in skill frontmatter is read", () => {
  it("keeps a `disable-model-invocation` skill out of what the model is told exists", async () => {
    const manager = await managerOver(
      skillsDirWith({
        deploy: "name: deploy\ndescription: Ship it\ndisable-model-invocation: true",
        lookup: "name: lookup\ndescription: Read a record",
      }),
    );
    expect(
      await modelVisible(manager),
      "the model was offered a skill whose author declared it must not fire on its own",
    ).toEqual(["lookup"]);
  });

  it("still resolves that skill by name", async () => {
    // The rule is about DISCLOSURE, not execution. A caller naming the skill has already decided,
    // so hiding it from the model must not also make it unreachable.
    const manager = await managerOver(
      skillsDirWith({
        deploy: "name: deploy\ndescription: Ship it\ndisable-model-invocation: true",
      }),
    );
    const detail = await manager.get("deploy");
    expect(detail?.instructions, "a disclosure rule was applied as an execution rule").toContain(
      "Body of deploy.",
    );
  });

  it("leaves a skill that declares nothing visible to the model", async () => {
    // The control. A filter that hid everything would satisfy the first test and disclose nothing.
    const manager = await managerOver(
      skillsDirWith({ lookup: "name: lookup\ndescription: Read a record" }),
    );
    expect(await modelVisible(manager)).toEqual(["lookup"]);
  });

  it("refuses a flag value this dialect cannot read, rather than disclosing the skill", async () => {
    // `yes` is a YAML boolean and this dialect coerces only the literals `true`/`false`, so it
    // arrives as the string "yes", compares unequal to `true`, and the skill would be disclosed.
    // The author wrote a restriction and would have got the default — a restriction that fails open
    // is worse than an absent one, because the author stops looking.
    //
    // Discovery reports an invalid skill instead of throwing, so the skill is excluded from the
    // listing entirely and the reason is reported. Either way it never reaches the model silently.
    const dir = skillsDirWith({
      deploy: "name: deploy\ndescription: Ship it\ndisable-model-invocation: yes",
    });
    const manager = await managerOver(dir);
    expect(
      (await manager.list()).map((s) => s.name),
      "an unreadable authorization value left the skill in the listing",
    ).toEqual([]);
  });

  it("carries `user-invocable` to the host instead of discarding it", async () => {
    const manager = await managerOver(
      skillsDirWith({ internal: "name: internal\ndescription: Reference\nuser-invocable: false" }),
    );
    const [skill] = await manager.list();
    expect(
      skill?.userInvocable,
      "the scaffold's declaration reached the runtime and was thrown away",
    ).toBe(false);
  });
});
