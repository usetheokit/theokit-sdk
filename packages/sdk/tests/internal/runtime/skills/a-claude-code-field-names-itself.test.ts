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
 * **This decision changed on 2026-09-15, and the reasoning that held it is kept rather than
 * deleted.** It read:
 *
 *   "The failing is deliberate and stays. [...] a file that HAS frontmatter and gets it wrong is a
 *   broken agent and still fails loudly, which is what keeps a typo'd `sandbox` from returning as a
 *   silent gate through this door. Isolating the failure per file would hand that risk back."
 *
 * The risk it names is real, and the isolation that replaced it is NARROWER than the one that
 * argument refuses. Only `KNOWN_CLAUDE_CODE_FIELDS` is skipped — the set that already encodes "this
 * key belongs to another runtime and carries no behaviour here". A misspelling of one of OUR keys
 * still propagates, so `sandboxx` stays fatal and cannot return as a silent gate. The last case
 * below pins that half, and it is the half that must never be relaxed.
 *
 * What moved the decision was the cost, measured in a live TUI: one ported `.claude/agents/*.md`
 * carrying `memory:` stopped every sibling agent from loading and the turn produced no answer at
 * all, on an agent the task never used — while another runtime, same prompt and same project,
 * answered normally. The diagnosis fix below tells a user WHICH key is foreign; it does not give
 * them back the turn.
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
  it("skips the foreign file and loads its healthy sibling", async () => {
    const dir = agentsDir({
      "ok.md": ok,
      "ported.md": "---\nname: ported\ndescription: d\nmemory: project\n---\nbody\n",
    });

    const loaded = await loadSubagents(dir, true, undefined, []);

    expect(Object.keys(loaded), "the directory used to fail whole").toContain("ok-agent");
    expect(Object.keys(loaded), "the foreign file itself does not load").not.toContain("ported");
  });

  it("a genuinely unknown field is STILL fatal — the half that must not be relaxed", async () => {
    // `sandboxx` is our own field, misspelled. Skipping it would load an agent whose sandbox the
    // author believed they had set: the silent gate the previous decision existed to prevent.
    const dir = agentsDir({
      "typo.md": "---\nname: t\ndescription: d\nsandboxx: true\n---\nb\n",
    });

    await expect(loadSubagents(dir, true, undefined, [])).rejects.toThrow(/sandboxx/);
  });

  it("loads a clean directory", async () => {
    // The control. A change that stopped throwing would satisfy nothing above but must not pass here
    // by breaking the happy path.
    const dir = agentsDir({ "ok.md": ok });
    const loaded = await loadSubagents(dir, true, undefined, []);
    expect(Object.keys(loaded)).toContain("ok-agent");
  });
});
