import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { loadSubagents } from "../../../../src/internal/runtime/skills/subagents-loader.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * A subagent carrying Claude Code frontmatter fails the whole directory, and the message names one
 * key while a dozen siblings would do the same.
 *
 * **The failing is deliberate and stays.** The no-frontmatter case above it records why the line is
 * drawn where it is: skipping was added only for files that declare nothing, because "a file that
 * HAS frontmatter and gets it wrong is a broken agent and still fails loudly, which is what keeps a
 * typo'd `sandbox` from returning as a silent gate through this door." Isolating the failure per
 * file would hand that risk back.
 *
 * What is fixable is the DIAGNOSIS. Measured: a directory with one valid agent and one carrying
 * `memory: project` loads nothing, with `unknown frontmatter field "memory"`. A user migrating a
 * `.claude/agents/` tree meets that on the first file, fixes it, meets `permissionMode`, fixes that,
 * meets `maxTurns` — learning one key per round trip, with no signal that the set is finite or that
 * their tree is simply written for another runtime.
 *
 * So the message now says which kind of unknown it is. That distinction is one this file already
 * draws for `INERT_CLAUDE_CODE_FIELDS`: "the difference between 'we know this one and it does
 * nothing' and 'we have never heard of this' — two facts a bare allow-everything would collapse into
 * one." A third fact belongs beside them: "this is another runtime's field, and here are its
 * siblings."
 */
function agentsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-cc-field-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  mkdirSync(join(dir, ".theokit", "agents"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, ".theokit", "agents", name), body);
  }
  return dir;
}

const ok = "---\nname: ok-agent\ndescription: d\n---\nbody\n";

describe("a Claude Code frontmatter field names itself", () => {
  it("says the field belongs to another runtime, and names its siblings", async () => {
    const dir = agentsDir({
      "ok.md": ok,
      "ported.md": "---\nname: ported\ndescription: d\nmemory: project\n---\nbody\n",
    });

    const error = await loadSubagents(dir, true, undefined, []).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(
      message,
      "the message named one key and left the user to discover the other twelve one failure at a time",
    ).toMatch(/permissionMode|another runtime|Claude Code/i);
  });

  it("still fails loudly, which is the decision this test does not touch", async () => {
    const dir = agentsDir({
      "ported.md": "---\nname: p\ndescription: d\nmemory: project\n---\nb\n",
    });
    await expect(loadSubagents(dir, true, undefined, [])).rejects.toThrow(/memory/);
  });

  it("loads a clean directory", async () => {
    // The control. A change that stopped throwing would satisfy nothing above but must not pass here
    // by breaking the happy path.
    const dir = agentsDir({ "ok.md": ok });
    const loaded = await loadSubagents(dir, true, undefined, []);
    expect(Object.keys(loaded)).toContain("ok-agent");
  });
});
