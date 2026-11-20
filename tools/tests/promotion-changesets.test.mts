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

/*
 * #863 — a PR into develop: the Version Packages deletion lands on main only, and a back-merge can
 * keep the files (they were added by separate commits on the head side).
 */
describe("promotion into develop is also checked against main (#863)", () => {
  const F = ".changeset/released.md";
  let d2: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", d2, ...a], { encoding: "utf8" }).trim();
  const ci = (m: string) => {
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m);
  };
  const run = (base: string, head: string) => {
    const r = spawnSync("node", [GUARD, base, head], {
      cwd: d2,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: join(d2, ".git") },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeAll(() => {
    d2 = mkdtempSync(join(tmpdir(), "reconsumed-863-"));
    g("init", "-q", "-b", "main");
    mkdirSync(join(d2, ".changeset"));
    writeFileSync(join(d2, ".changeset/README.md"), "readme\n");
    ci("base");
    g("branch", "develop");
    writeFileSync(join(d2, F), "---\n---\nx\n");
    ci("add on main");
    g("branch", "workspace");
    g("rm", "-q", F);
    ci("Version Packages");
    g("checkout", "-q", "workspace");
  });
  afterAll(() => rmSync(d2, { recursive: true, force: true }));

  it("flags a changeset main consumed, and says to back-merge while main is not an ancestor", () => {
    const r = run("develop", "workspace");
    expect(r.code).toBe(1);
    expect(r.out).toContain(F);
    expect(r.out).toContain("back-merge main into workspace");
  });

  it("says to delete the files once main is an ancestor yet the copy survived", () => {
    g("checkout", "-q", "-b", "kept", "workspace");
    g("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "-s", "ours", "main");
    const r = run("develop", "kept");
    expect(r.code).toBe(1);
    expect(r.out).toContain(F);
    expect(r.out).toContain("already merged");
    expect(r.out).not.toContain("back-merge main into kept");
  });

  it("passes once the file is deleted", () => {
    g("rm", "-q", F);
    ci("delete");
    const r = run("develop", "kept");
    expect(r.code).toBe(0);
  });

  it("refuses (exit 2) when the release ref is missing", () => {
    g("branch", "-m", "main", "gone");
    const r = run("develop", "kept");
    expect(r.code).toBe(2);
    expect(r.out).toContain("main");
    g("branch", "-m", "gone", "main");
  });
});

/*
 * #1415 — develop -> main failed on `.changeset/scripted-model-server.md`: the file was added on
 * develop, consumed by a "Version Packages" merge on main, and develop had not back-merged main.
 * The cause is fixed by the back-merge (which deletes the file), not by relaxing the guard.
 */
describe("promotion: back-merge of main clears a consumed changeset (#1415)", () => {
  const F = ".changeset/scripted-model-server.md";
  let d3: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", d3, ...a], { encoding: "utf8" }).trim();
  const ci = (m: string) => {
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m);
  };
  const run = (base: string, head: string) => {
    const r = spawnSync("node", [GUARD, base, head], {
      cwd: d3,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: join(d3, ".git") },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeAll(() => {
    d3 = mkdtempSync(join(tmpdir(), "reconsumed-1415-"));
    g("init", "-q", "-b", "main");
    mkdirSync(join(d3, ".changeset"));
    writeFileSync(join(d3, ".changeset/README.md"), "readme\n");
    ci("base");
    writeFileSync(join(d3, F), "---\n---\nx\n");
    ci("feature with changeset");
    g("branch", "develop");
    g("rm", "-q", F);
    ci("Version Packages");
    g("checkout", "-q", "develop");
  });
  afterAll(() => rmSync(d3, { recursive: true, force: true }));

  it("rejects the head that still holds the consumed changeset", () => {
    const r = run("main", "develop");
    expect(r.code).toBe(1);
    expect(r.out).toContain(F);
  });

  it("accepts the head once main is merged back in", () => {
    g("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "main");
    const r = run("main", "develop");
    expect(r.code).toBe(0);
    expect(g("ls-tree", "--name-only", "develop", ".changeset/")).not.toContain("scripted-model-server");
  });
});
