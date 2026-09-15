// A subagent's `memory:` declaration is CARRIED, and applying it stays the host's job.
//
// `memory` sat in `KNOWN_CLAUDE_CODE_FIELDS` — the set meaning "another runtime's key, no behaviour
// here" — and the file was refused. That was right while nothing could act on it. It stopped being
// right once `@theokit/agents` shipped `resolveAgentMemory`, with three roots and a stated reason
// for refusing an unrecognised one: the roots differ in WHO CAN SEE the notes, so guessing would
// publish something written expecting privacy.
//
// The reader exists and the declaration could not reach it. Measured 2026-09-15 in a live TUI: an
// agent file carrying `memory: project` was skipped, so the host never learned that agent wanted a
// memory root, and the function with no caller stayed a function with no caller.
//
// ## What this deliberately does NOT do
//
// The SDK does not resolve the root, read `MEMORY.md`, or touch the prompt. It does not depend on
// `@theokit/agents`, and a second implementation of the three-root rule is how the two drift into
// disagreeing about who can see a note. It carries the value and stops — the same split the
// surfaces documentation already describes as "resolvable by the host".

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSubagents } from "../src/internal/runtime/skills/subagents-loader.js";

async function withAgent<T>(body: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-memory-"));
  const dir = join(cwd, ".theokit", "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.md"), body);
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("a subagent's memory declaration", () => {
  it("loads the agent and carries the declared scope", async () => {
    const defs = await withAgent(
      `---\nname: a\ndescription: d\nmemory: project\n---\nbody`,
      (cwd) => loadSubagents(cwd, true, undefined),
    );
    expect(defs.a, "the file used to be skipped entirely").toBeDefined();
    expect(defs.a?.memory).toBe("project");
  });

  it.each([
    "project",
    "local",
    "user",
  ])("carries %s verbatim, without judging it", async (scope) => {
    const defs = await withAgent(
      `---\nname: a\ndescription: d\nmemory: ${scope}\n---\nbody`,
      (cwd) => loadSubagents(cwd, true, undefined),
    );
    expect(defs.a?.memory).toBe(scope);
  });

  it("carries an unrecognised scope rather than refusing it here", async () => {
    // `resolveAgentMemory` refuses an unknown scope, with a reason about who can see the notes.
    // Refusing it twice, in two places, means two lists to keep in agreement — and this one would
    // reject a scope a newer `@theokit/agents` had learned.
    const defs = await withAgent(
      `---\nname: a\ndescription: d\nmemory: something-else\n---\nbody`,
      (cwd) => loadSubagents(cwd, true, undefined),
    );
    expect(defs.a?.memory).toBe("something-else");
  });

  it("leaves the field absent when the frontmatter does not declare it", async () => {
    const defs = await withAgent(`---\nname: a\ndescription: d\n---\nbody`, (cwd) =>
      loadSubagents(cwd, true, undefined),
    );
    expect(defs.a?.memory).toBeUndefined();
  });

  it("does not touch the prompt — reading MEMORY.md is the host's job", async () => {
    const defs = await withAgent(
      `---\nname: a\ndescription: d\nmemory: project\n---\njust the body`,
      (cwd) => loadSubagents(cwd, true, undefined),
    );
    expect(defs.a?.prompt.trim()).toBe("just the body");
  });
});
