import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeProjectMemoryDir } from "../../../src/internal/memory/storage/memory-root.js";

/**
 * `MEMORY.md` names two different contracts, and only one of them is this SDK's.
 *
 * The Claude Code CLI's is a plain file under its own home, capped at 200 lines / 25 KB on read and
 * swept on `cleanupPeriodDays`. This SDK's is the durable-memory subsystem — a SQLite+FTS5 store
 * under `.theokit/memory/` with `memory_search` / `memory_get` tools, no index cap, and a different
 * directory entirely.
 *
 * ## What the survey got wrong, corrected by measurement
 *
 * The item said `CLAUDE_CONFIG_DIR` returned 0 files and auto memory was absent. Measured across
 * BOTH packages: `CLAUDE_CONFIG_DIR` is 1 here and 0 in `@theokit/agents`, and
 * `claudeProjectMemoryDir` is 2 here. The original grep ran only against `packages/agents/src`,
 * where it is indeed absent, and reported it absent everywhere.
 *
 * What IS absent: the CLI's auto-memory BEHAVIOUR. `autoMemoryEnabled`, `autoMemoryDirectory`,
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and `cleanupPeriodDays` measure 0 in both packages, and the read
 * cap has no counterpart.
 *
 * Interop in one direction is the decision: a memory the CLI recorded stays visible, and this
 * runtime does not write into a store another product owns the lifecycle of. A `cleanupPeriodDays`
 * implemented here would delete files the CLI expects to find.
 */
const SOURCE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "src",
  "internal",
  "memory",
  "storage",
  "memory-root.ts",
);

describe("the two MEMORY.md files are different things", () => {
  it("honours CLAUDE_CONFIG_DIR for the CLI's directory", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/custom/home";
    try {
      expect(
        claudeProjectMemoryDir(process.cwd()).startsWith("/custom/home/projects/"),
        "the CLI's own relocation variable was ignored, so interop read the wrong directory",
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it("falls back to the CLI's default home when it is unset", () => {
    // The control. An unset variable must not produce a path rooted at the empty string — that is
    // how a relocation variable becomes a read of `/projects/...`.
    const previous = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      expect(claudeProjectMemoryDir(process.cwd()).startsWith("/projects/")).toBe(false);
      expect(claudeProjectMemoryDir(process.cwd())).toContain(".claude");
    } finally {
      if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it("treats an empty variable as unset rather than as a root", () => {
    // `CLAUDE_CONFIG_DIR=""` is what an unset shell variable expands to in a wrapper script. Reading
    // it as a root produces `/projects/...`, which exists on no machine and fails silently as
    // "the CLI has no memories here".
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "   ";
    try {
      expect(claudeProjectMemoryDir(process.cwd())).toContain(".claude");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it("says at the source which contract this is", () => {
    // The collision is the defect, so the statement lives where a grep lands. A docblock nothing
    // checks is a docblock that gets tidied away.
    const source = readFileSync(SOURCE, "utf8");
    expect(source).toContain("names two different contracts");
    expect(source, "the unimplemented half was dropped").toContain("cleanupPeriodDays");
  });
});
