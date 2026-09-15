// A subagent written for another runtime must not take the directory down with it.
//
// `KNOWN_CLAUDE_CODE_FIELDS` already establishes the fact that a key belongs to the Claude Code
// CLI and carries no behaviour here. Until now that fact changed only the error MESSAGE, never the
// verdict: one `.claude/agents/*.md` carrying `memory:` threw, and the throw propagated out of
// `loadSubagents`, so EVERY agent in the directory failed to load and the turn produced nothing.
// Measured 2026-09-15 in a live TUI — a config key on an agent the task never used killed the run.
//
// The loader already draws this exact distinction for a file with no frontmatter: skip with a warn
// rather than "stop every agent in the directory from loading". The rationale it kept for failing
// loudly — "keeps a typo'd `sandbox` from returning as a silent gate through this door" — does not
// reach these keys: they are a KNOWN foreign field, not a misspelling of one of ours. A genuinely
// unknown key must still be fatal, which is what the second test pins.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSubagents } from "../src/internal/runtime/skills/subagents-loader.js";

async function withAgents<T>(
  files: Record<string, string>,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "foreign-field-"));
  const dir = join(cwd, ".theokit", "agents");
  await mkdir(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.md`), contents);
  }
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const GOOD = `---\nname: good\ndescription: a healthy agent\n---\nbody`;

describe("subagent loader — a foreign-runtime field skips its own file, not the directory", () => {
  it("loads the healthy sibling when another agent declares memory:", async () => {
    const foreign = `---\nname: foreign\ndescription: written for Claude Code\nmemory: project\n---\nbody`;
    const defs = await withAgents({ good: GOOD, foreign }, (cwd) =>
      loadSubagents(cwd, true, undefined),
    );
    expect(defs.good).toBeDefined();
    expect(defs.foreign).toBeUndefined();
  });

  it.each([
    "permissionMode: acceptEdits",
    "maxTurns: 5",
    "hooks: {}",
  ])("skips a file carrying %s and still loads the sibling", async (field) => {
    const foreign = `---\nname: foreign\ndescription: d\n${field}\n---\nbody`;
    const defs = await withAgents({ good: GOOD, foreign }, (cwd) =>
      loadSubagents(cwd, true, undefined),
    );
    expect(defs.good).toBeDefined();
  });

  it("a genuinely unknown field is STILL fatal — a typo must not become a silent gate", async () => {
    // `sandboxx` is the case the loud path exists for: our own field, misspelled. Skipping it would
    // load an agent whose sandbox the author believed they had set.
    const typo = `---\nname: typo\ndescription: d\nsandboxx: true\n---\nbody`;
    await expect(
      withAgents({ good: GOOD, typo }, (cwd) => loadSubagents(cwd, true, undefined)),
    ).rejects.toThrow(/sandboxx/);
  });
});
