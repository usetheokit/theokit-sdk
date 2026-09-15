// A subagent written for another runtime must not take the directory down with it.
//
// Companion to `internal/runtime/skills/a-claude-code-field-names-itself.test.ts`, which carries
// the decision and the reasoning that preceded it. This file covers the SIBLINGS of `memory:` —
// the rest of `KNOWN_CLAUDE_CODE_FIELDS` — and the control that keeps the change narrow.

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

describe("a foreign-runtime field skips its own file, not the directory", () => {
  it.each([
    "permissionMode: acceptEdits",
    "maxTurns: 5",
    "hooks: {}",
    "skills: [a]",
  ])("skips a file carrying %s and still loads the sibling", async (field) => {
    const foreign = `---\nname: foreign\ndescription: d\n${field}\n---\nbody`;
    const defs = await withAgents({ good: GOOD, foreign }, (cwd) =>
      loadSubagents(cwd, true, undefined),
    );
    expect(Object.keys(defs)).toContain("good");
    expect(Object.keys(defs)).not.toContain("foreign");
  });

  it("a whole directory of foreign files loads nothing and throws nothing", async () => {
    // The migration case: a `.claude/agents/` tree ported wholesale. It must not produce agents,
    // and it must not stop the run — the user gets a working session and a diagnostic per file.
    const defs = await withAgents(
      {
        a: `---\nname: a\ndescription: d\nmemory: project\n---\nb`,
        b: `---\nname: b\ndescription: d\nmaxTurns: 2\n---\nb`,
      },
      (cwd) => loadSubagents(cwd, true, undefined),
    );
    expect(Object.keys(defs)).toEqual([]);
  });

  it("an unknown field that is NOT a Claude Code key is still fatal", async () => {
    // The control that keeps this change narrow. `widgets` is neither ours nor theirs: nothing
    // establishes it as another runtime's, so it stays the loud failure it always was.
    const odd = `---\nname: odd\ndescription: d\nwidgets: 3\n---\nbody`;
    await expect(
      withAgents({ good: GOOD, odd }, (cwd) => loadSubagents(cwd, true, undefined)),
    ).rejects.toThrow(/widgets/);
  });
});
