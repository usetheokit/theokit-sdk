import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * #1235 — develop -> main failed `no re-consumed changesets`: main had consumed five changesets
 * in a "Version Packages" merge that develop still held. The fixture below rebuilds that history
 * in a throwaway repository (full history by construction, so no dependence on the checkout's
 * fetch depth or on origin/main existing) and runs the real guard against it via GIT_DIR.
 */
const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "check-no-reconsumed-changesets.mjs");
const OFFENDERS = [
  "mcp-tool-filter",
  "sdk-acquire-instance-lock",
  "sdk-instance-lock",
  "squad-run-cancel-dispose",
  "workflow-containers-cancel",
].map((n) => `.changeset/${n}.md`);

let dir: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function commitAll(msg: string): void {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
}

function guard(base: string, head: string) {
  const r = spawnSync("node", [GUARD, base, head], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: join(dir, ".git") },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "reconsumed-"));
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".changeset"));
  for (const p of OFFENDERS) writeFileSync(join(dir, p), "---\n---\nchange\n");
  writeFileSync(join(dir, ".changeset/README.md"), "readme\n");
  commitAll("develop holds the changesets");
  git("branch", "develop");
  // main's "Version Packages" merge consumes them.
  git("rm", "-q", ...OFFENDERS);
  commitAll("Version Packages");
  // develop later adds an unrelated new changeset.
  git("checkout", "-q", "develop");
  writeFileSync(join(dir, ".changeset/brand-new.md"), "---\n---\nnew\n");
  commitAll("new work");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("promotion: no re-consumed changesets", () => {
  it("rejects a develop that still holds the five consumed changesets", () => {
    const r = guard("main", "develop");
    expect(r.code).toBe(1);
    for (const p of OFFENDERS) expect(r.out).toContain(p);
    expect(r.out).not.toContain("brand-new.md");
  });

  it("accepts develop once main is back-merged", () => {
    git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "main");
    const r = guard("main", "develop");
    expect(r.out).toContain("✓");
    expect(r.code).toBe(0);
  });

  it("accepts a develop that deleted the consumed files itself and keeps its new changeset", () => {
    const pre = git("rev-parse", "HEAD^1");
    git("checkout", "-q", "-b", "cleanup", pre);
    git("rm", "-q", ...OFFENDERS);
    commitAll("drop consumed changesets");
    const r = guard("main", "cleanup");
    expect(r.out).toContain("✓");
    expect(r.code).toBe(0);
    expect(git("ls-tree", "--name-only", "cleanup", ".changeset/")).toContain("brand-new.md");
  });
});
