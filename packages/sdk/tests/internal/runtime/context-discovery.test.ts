/**
 * Tests for context-discovery.ts (T1.1, ADRs D150 / D151).
 */

import { symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import {
  DEFAULT_DISCOVERY_SPECS,
  findGitRoot,
  isSafePattern,
  walkUpForFile,
  walkUpForGlob,
} from "../../../src/internal/runtime/context/context-discovery.js";
import { removeTempDirRobust } from "../../helpers/temp-workspace.js";

describe("context-discovery (T1.1)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "theokit-ctx-discovery-"));
    const __tmpCleanup1 = tmp;
    onTestFinished(async () => {
      await removeTempDirRobust(__tmpCleanup1);
    });
  });
  afterEach(() => {
    // best-effort cleanup; tmp dir auto-collected
  });

  // ── findGitRoot ──
  it("findGitRoot returns dir with .git directory", async () => {
    await mkdir(join(tmp, ".git"), { recursive: true });
    expect(findGitRoot(tmp)).toBe(tmp);
  });

  it("findGitRoot walks up until found", async () => {
    await mkdir(join(tmp, ".git"), { recursive: true });
    const deep = join(tmp, "packages/foo/src");
    await mkdir(deep, { recursive: true });
    expect(findGitRoot(deep)).toBe(tmp);
  });

  it("findGitRoot returns undefined when no .git anywhere", () => {
    expect(findGitRoot(tmp)).toBeUndefined();
  });

  // EC-N: git worktrees
  it("EC-N: findGitRoot handles .git as a FILE (worktree)", async () => {
    writeFileSync(join(tmp, ".git"), "gitdir: /var/empty/.git");
    expect(findGitRoot(tmp)).toBe(tmp);
  });

  // ── walkUpForFile ──
  it("walkUpForFile returns nearest first", async () => {
    await mkdir(join(tmp, ".git"), { recursive: true });
    await writeFile(join(tmp, "AGENTS.md"), "root");
    await mkdir(join(tmp, "packages/foo"), { recursive: true });
    await writeFile(join(tmp, "packages/foo/AGENTS.md"), "nested");
    const found = walkUpForFile(join(tmp, "packages/foo"), "AGENTS.md", tmp);
    expect(found.length).toBe(2);
    expect(found[0]).toContain("packages/foo/AGENTS.md");
    expect(found[1]).toContain(`${tmp}/AGENTS.md`);
  });

  it("walkUpForFile stops at git root", async (ctx) => {
    await mkdir(join(tmp, ".git"), { recursive: true });
    // File ABOVE the git root should NOT be discovered.
    const parentFile = join(tmp, "..", `outside-${Date.now()}.md`);
    try {
      writeFileSync(parentFile, "should-not-see");
    } catch {
      // Filesystem refused the write above the git root: report SKIPPED, never
      // PASS — the assertion below would otherwise be silently unexercised.
      ctx.skip("filesystem refused writing a probe file above the git root");
    }
    const found = walkUpForFile(tmp, "AGENTS.md", tmp);
    expect(found).toEqual([]);
  });

  it("walkUpForFile returns empty when no match", () => {
    expect(walkUpForFile(tmp, "AGENTS.md", undefined)).toEqual([]);
  });

  // EC-F: realpath dedup for symlink chains
  it("EC-F: walkUpForFile dedups symlinks pointing to the same physical file", async () => {
    await writeFile(join(tmp, "AGENTS.md"), "real");
    await mkdir(join(tmp, "sub"), { recursive: true });
    symlinkSync(join(tmp, "AGENTS.md"), join(tmp, "sub", "AGENTS.md"));
    const found = walkUpForFile(join(tmp, "sub"), "AGENTS.md", tmp);
    // Both /tmp/sub/AGENTS.md (symlink) + /tmp/AGENTS.md (real) resolve to
    // the same realpath, so only one entry survives.
    expect(found.length).toBe(1);
  });

  it("path traversal pattern rejected", () => {
    expect(walkUpForFile(tmp, "../etc/passwd", undefined)).toEqual([]);
    expect(walkUpForFile(tmp, "../AGENTS.md", undefined)).toEqual([]);
  });

  it("absolute filename pattern rejected", () => {
    expect(walkUpForFile(tmp, "/etc/passwd", undefined)).toEqual([]);
  });

  // ── walkUpForGlob ──
  it("walkUpForGlob matches files in .cursor/rules", async () => {
    await mkdir(join(tmp, ".cursor", "rules"), { recursive: true });
    await writeFile(join(tmp, ".cursor", "rules", "ts.mdc"), "rule1");
    await writeFile(join(tmp, ".cursor", "rules", "py.mdc"), "rule2");
    await writeFile(join(tmp, ".cursor", "rules", "ignore.txt"), "skip");
    const found = await walkUpForGlob(tmp, ".cursor/rules/*.mdc");
    expect(found.length).toBe(2);
    expect(found.every((p) => p.endsWith(".mdc"))).toBe(true);
  });

  it("walkUpForGlob returns lex-sorted results", async () => {
    await mkdir(join(tmp, ".cursor", "rules"), { recursive: true });
    await writeFile(join(tmp, ".cursor", "rules", "z.mdc"), "z");
    await writeFile(join(tmp, ".cursor", "rules", "a.mdc"), "a");
    await writeFile(join(tmp, ".cursor", "rules", "m.mdc"), "m");
    const found = await walkUpForGlob(tmp, ".cursor/rules/*.mdc");
    expect(found.map((p) => p.split("/").pop())).toEqual(["a.mdc", "m.mdc", "z.mdc"]);
  });

  it("walkUpForGlob returns empty when dir missing", async () => {
    expect(await walkUpForGlob(tmp, ".cursor/rules/*.mdc")).toEqual([]);
  });

  // ── default specs ──
  // 8 -> 9 when THEO.md.root joined the array (#531): THEO.md was the only sibling that could
  // not live at the project root, and the fix ADDS a spec rather than moving the existing one, so
  // the count and the id list both grow by one instead of a name changing in place.
  it("DEFAULT_DISCOVERY_SPECS contains 12 entries", () => {
    expect(DEFAULT_DISCOVERY_SPECS.length).toBe(12);
    const ids = DEFAULT_DISCOVERY_SPECS.map((s) => s.id);
    expect(ids).toEqual([
      "AGENTS.md",
      "GEMINI.md",
      "CLAUDE.md",
      "cursor-rules",
      "theokit-rules",
      "claude-rules",
      "theokit-context",
      "THEO.md.root",
      "THEO.md",
      // B-023 — the private `*.local.md` chain, last so a correction is composed after the rule it
      // corrects. The count is written out rather than derived on purpose: a test that recomputed it
      // would agree with any addition, which is the opposite of what this case is for.
      "AGENTS.local.md",
      "CLAUDE.local.md",
      "THEO.local.md",
    ]);
  });

  it("DEFAULT_DISCOVERY_SPECS sorted by priority ascending", () => {
    const priorities = DEFAULT_DISCOVERY_SPECS.map((s) => s.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it("isSafePattern accepts dotfiles + slash + star", () => {
    expect(isSafePattern("AGENTS.md")).toBe(true);
    expect(isSafePattern(".theokit/THEO.md")).toBe(true);
    expect(isSafePattern(".cursor/rules/*.mdc")).toBe(true);
  });

  it("isSafePattern rejects traversal + absolute", () => {
    expect(isSafePattern("../etc/passwd")).toBe(false);
    expect(isSafePattern("/etc/passwd")).toBe(false);
    expect(isSafePattern("")).toBe(false);
  });
});
