/**
 * M6-3 — `provisionRepo` over `SandboxBackend.execute`.
 *
 * Drives the real `LocalSandbox` against a real temp git repository (no mocks):
 * clone + checkout a ref into an isolated dir, typed `RepoProvisionError` on
 * git failure. Per ADR D2 the provisioner rides `execute`, never `child_process`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../src/sandbox/local-sandbox.js";
import { provisionRepo, RepoProvisionError } from "../../src/sandbox/provision.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("provisionRepo (M6-3)", () => {
  let root: string;
  let source: string;
  let work: string;
  let headSha: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "theo-provision-"));
    source = join(root, "source");
    work = join(root, "work");
    mkdirSync(source);
    mkdirSync(work);
    git(source, "init", "--quiet");
    git(source, "config", "user.email", "t@t.dev");
    git(source, "config", "user.name", "tester");
    writeFileSync(join(source, "README.md"), "hello\n");
    git(source, "add", "README.md");
    git(source, "commit", "--quiet", "-m", "initial");
    headSha = git(source, "rev-parse", "HEAD");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("clones and checks out a ref into an isolated dir", async () => {
    const sandbox = new LocalSandbox({ workDir: work });
    const { repoDir } = await provisionRepo(sandbox, {
      repoUrl: source,
      ref: headSha,
      instanceId: "inst-1",
    });
    expect(repoDir).toBe(join(realpathSync(work), "inst-1"));
    expect(existsSync(join(repoDir, "README.md"))).toBe(true);
    expect(git(repoDir, "rev-parse", "HEAD")).toBe(headSha);
  });

  it("test_provisionRepo_defaults_to_local_sandbox", async () => {
    // V3-5 (b): the 1-arg overload constructs a default LocalSandbox and runs git
    // through it — proven WITHOUT touching the filesystem (no cwd dependency,
    // parallel-safe: process.chdir is unreliable in vitest's worker pool, EC-1)
    // by attempting to clone a nonexistent repo: the default backend executes
    // `git clone`, which exits non-zero, surfacing the typed RepoProvisionError.
    // The successful clone+checkout mechanics share the identical post-discriminator
    // path already covered by "clones and checks out a ref into an isolated dir".
    await expect(
      provisionRepo({
        repoUrl: join(root, "does-not-exist"),
        ref: "HEAD",
        instanceId: "inst-default",
      }),
    ).rejects.toMatchObject({ name: "RepoProvisionError", instanceId: "inst-default" });
  });

  it("test_provisionRepo_single_arg_invalid_instanceId_throws", async () => {
    // EC-2: a single arg is routed to `opts` (not `sandbox`); validation runs.
    await expect(
      provisionRepo({ repoUrl: source, ref: headSha, instanceId: "../evil" }),
    ).rejects.toBeInstanceOf(RepoProvisionError);
  });

  it("throws RepoProvisionError naming the instanceId on a bad ref", async () => {
    const sandbox = new LocalSandbox({ workDir: work });
    await expect(
      provisionRepo(sandbox, {
        repoUrl: source,
        ref: "0000000000000000000000000000000000000000",
        instanceId: "inst-bad-ref",
      }),
    ).rejects.toMatchObject({ name: "RepoProvisionError", instanceId: "inst-bad-ref" });
  });

  it("throws RepoProvisionError on a nonexistent repo", async () => {
    const sandbox = new LocalSandbox({ workDir: work });
    await expect(
      provisionRepo(sandbox, {
        repoUrl: join(root, "does-not-exist"),
        ref: "HEAD",
        instanceId: "inst-x",
      }),
    ).rejects.toBeInstanceOf(RepoProvisionError);
  });

  // --- Security regression tests (testing.md §3: every fix ships a regression test) ---

  it("rejects an instanceId with path traversal before touching git", async () => {
    const sandbox = new LocalSandbox({ workDir: work });
    for (const bad of ["../escape", "a/b", "..", ".", "-flag", "x;touch y"]) {
      await expect(
        provisionRepo(sandbox, { repoUrl: source, ref: headSha, instanceId: bad }),
      ).rejects.toMatchObject({ name: "RepoProvisionError" });
    }
  });

  it("rejects a ref that begins with '-' (git flag injection)", async () => {
    const sandbox = new LocalSandbox({ workDir: work });
    await expect(
      provisionRepo(sandbox, { repoUrl: source, ref: "--orphan", instanceId: "inst-ref" }),
    ).rejects.toMatchObject({ name: "RepoProvisionError" });
  });

  it("blocks the ext:: transport (arbitrary-command RCE vector)", async () => {
    const sandbox = new LocalSandbox({ workDir: work });
    const marker = join(root, "PWNED");
    await expect(
      provisionRepo(sandbox, {
        repoUrl: `ext::sh -c "touch ${marker}"`,
        ref: "HEAD",
        instanceId: "inst-ext",
      }),
    ).rejects.toBeInstanceOf(RepoProvisionError);
    expect(existsSync(marker)).toBe(false); // payload never executed
  });

  describe("timeoutMs and attempts", () => {
    function wrap(sb: LocalSandbox, failClones: number) {
      const calls: { command: string; opts?: { timeoutMs?: number } }[] = [];
      let failed = 0;
      const backend = Object.create(sb) as LocalSandbox;
      backend.execute = async (command: string, o?: { timeoutMs?: number }) => {
        calls.push({ command, ...(o ? { opts: o } : {}) });
        if (command.includes(" clone ") && failed < failClones) {
          failed++;
          // leave a partial directory behind, like a stalled clone
          mkdirSync(join(work, "inst-r"), { recursive: true });
          return { exitCode: 1, stdout: "", stderr: "timed out" } as never;
        }
        return sb.execute(command, o);
      };
      return { backend, calls };
    }

    it("forwards timeoutMs to the clone only", async () => {
      const { backend, calls } = wrap(new LocalSandbox({ workDir: work }), 0);
      await provisionRepo(backend, {
        repoUrl: source,
        ref: headSha,
        instanceId: "inst-r",
        timeoutMs: 5000,
      });
      expect(calls.find((c) => c.command.includes(" clone "))?.opts).toEqual({ timeoutMs: 5000 });
      expect(calls.filter((c) => c.opts).length).toBe(1);
    });

    it("retries after removing the partial directory", async () => {
      const { backend } = wrap(new LocalSandbox({ workDir: work }), 1);
      const { repoDir } = await provisionRepo(backend, {
        repoUrl: source,
        ref: headSha,
        instanceId: "inst-r",
        attempts: 2,
      });
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
    });

    it("fails after exhausting attempts", async () => {
      const { backend, calls } = wrap(new LocalSandbox({ workDir: work }), 5);
      await expect(
        provisionRepo(backend, {
          repoUrl: source,
          ref: headSha,
          instanceId: "inst-r",
          attempts: 2,
        }),
      ).rejects.toThrow(/clone failed: timed out/);
      expect(calls.filter((c) => c.command.includes(" clone ")).length).toBe(2);
    });

    it("does not retry by default", async () => {
      const { backend, calls } = wrap(new LocalSandbox({ workDir: work }), 5);
      await expect(
        provisionRepo(backend, { repoUrl: source, ref: headSha, instanceId: "inst-r" }),
      ).rejects.toThrow(/clone failed/);
      expect(calls.filter((c) => c.command.includes(" clone ")).length).toBe(1);
    });

    it("refuses to retry over a pre-existing directory", async () => {
      mkdirSync(join(work, "inst-r"));
      const { backend } = wrap(new LocalSandbox({ workDir: work }), 0);
      await expect(
        provisionRepo(backend, {
          repoUrl: source,
          ref: headSha,
          instanceId: "inst-r",
          attempts: 2,
        }),
      ).rejects.toThrow(/already exists/);
    });

    it("rejects invalid options", async () => {
      const sandbox = new LocalSandbox({ workDir: work });
      for (const bad of [
        { attempts: 0 },
        { attempts: 1.5 },
        { timeoutMs: 0 },
        { timeoutMs: Infinity },
      ]) {
        await expect(
          provisionRepo(sandbox, { repoUrl: source, ref: headSha, instanceId: "inst-o", ...bad }),
        ).rejects.toBeInstanceOf(RepoProvisionError);
      }
    });
  });
});
