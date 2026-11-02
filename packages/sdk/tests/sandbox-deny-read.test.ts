// B-610 — a `workspace-write` shell can name paths it must not read. The builder masks each listed
// path after the writable binds (`--tmpfs` for a directory, `--ro-bind /dev/null` for a file) and
// refuses a list it cannot honour. The live test needs bubblewrap and is skipped with the reason
// where it is absent.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildBwrapArgv,
  createSandboxBackend,
  detectBwrap,
  interactiveWrapCommand,
  LinuxSandbox,
  LocalSandbox,
  realProbes,
  SandboxNotAvailableError,
} from "../src/sandbox/index.js";

const LIVE = detectBwrap(realProbes).ok;
const itLive = LIVE ? it : it.skip; // reason: needs bubblewrap on the host

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "b610-")));
const workDir = path.join(root, "work");
const denyDir = path.join(root, "secrets");
const denyFile = path.join(root, "token.txt");
mkdirSync(workDir);
mkdirSync(denyDir);
writeFileSync(denyFile, "TOKEN-VALUE");
writeFileSync(path.join(workDir, "ok.txt"), "OK-VALUE");
writeFileSync(path.join(denyDir, "inner.txt"), "INNER-VALUE");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function argvWith(denyReadPaths: readonly string[]): string[] {
  const argv = buildBwrapArgv("workspace-write", {
    cwd: workDir,
    gitDirExists: false,
    denyReadPaths,
  });
  if (argv === null) throw new Error("expected an argv");
  return argv;
}

describe("buildBwrapArgv denyReadPaths", () => {
  it("places_masks_after_writable_binds_before_chdir", () => {
    const argv = argvWith([denyDir, denyFile]);
    const tmpBind = argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === "/tmp");
    const tmpfs = argv.indexOf("--tmpfs");
    const nullBind = argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null");
    const chdir = argv.indexOf("--chdir");
    expect(argv.slice(tmpfs, tmpfs + 2)).toEqual(["--tmpfs", denyDir]);
    expect(argv.slice(nullBind, nullBind + 3)).toEqual(["--ro-bind", "/dev/null", denyFile]);
    expect(tmpBind).toBeGreaterThan(-1);
    expect(tmpfs).toBeGreaterThan(tmpBind);
    expect(nullBind).toBeGreaterThan(tmpBind);
    expect(chdir).toBeGreaterThan(Math.max(tmpfs, nullBind));
  });

  it("leaves_argv_unchanged_without_a_deny_list", () => {
    const plain = buildBwrapArgv("workspace-write", { cwd: workDir, gitDirExists: false });
    expect(
      buildBwrapArgv("workspace-write", { cwd: workDir, gitDirExists: false, denyReadPaths: [] }),
    ).toEqual(plain);
    expect(
      buildBwrapArgv("workspace-write", {
        cwd: workDir,
        gitDirExists: false,
        denyReadPaths: undefined,
      }),
    ).toEqual(plain);
    expect(plain).not.toContain("--tmpfs");
  });

  it("collapses_duplicates_and_follows_symlinks_keeping_list_order", () => {
    const link = path.join(root, "link-to-token");
    symlinkSync(denyFile, link);
    const argv = argvWith([link, denyDir, denyFile]);
    expect(argv.filter((a) => a === denyFile)).toHaveLength(1);
    expect(argv.filter((a) => a === link)).toHaveLength(0);
    expect(argv.indexOf(denyFile)).toBeLessThan(argv.indexOf(denyDir));
  });

  it("rejects_relative_missing_and_workspace_covering_paths", () => {
    const missing = path.join(root, "does-not-exist");
    const cases = ["relative/secret", missing, workDir, root, path.dirname(root), "/tmp", "/"];
    for (const entry of cases) {
      let caught: unknown;
      try {
        argvWith([denyFile, entry]);
      } catch (e) {
        caught = e;
      }
      expect(caught, entry).toBeInstanceOf(TypeError);
      expect((caught as TypeError).message, entry).toContain(entry);
    }
  });

  it("rejects_a_deny_list_in_danger_full_access", () => {
    expect(() =>
      buildBwrapArgv("danger-full-access", { cwd: workDir, denyReadPaths: [denyFile] }),
    ).toThrow(TypeError);
    expect(buildBwrapArgv("danger-full-access", { cwd: workDir })).toBeNull();
  });
});

describe("denyReadPaths against a live bwrap", () => {
  itLive("bwrap_denies_a_file_and_a_directory_the_argv_masks", () => {
    const argv = argvWith([denyFile, denyDir]);
    const run = (command: string) =>
      spawnSync("bwrap", [...argv.slice(0, -1), "--", "/bin/sh", "-c", command], {
        encoding: "utf8",
      });

    const fileIn = run(`cat ${denyFile}`);
    const dirIn = run(`cat ${path.join(denyDir, "inner.txt")}`);
    const control = run(`cat ${path.join(workDir, "ok.txt")}`);

    expect(fileIn.status).not.toBe(0);
    expect(fileIn.stdout).not.toContain("TOKEN-VALUE");
    expect(dirIn.status).not.toBe(0);
    expect(dirIn.stdout).not.toContain("INNER-VALUE");
    expect(control.status).toBe(0);
    expect(control.stdout).toContain("OK-VALUE");
  });
});

const FAKE_BIN = "/usr/bin/bwrap";
const present = () => ({ ok: true as const, bin: FAKE_BIN });
const absent = () => ({ ok: false as const, reason: "bwrap not found in PATH" });
const quiet = () => undefined;

describe("denyReadPaths through the backends", () => {
  it("forwards_the_deny_list_to_the_wrapped_command", () => {
    const viaClass = new LinuxSandbox(
      { workDir },
      { mode: "workspace-write", bin: FAKE_BIN, denyReadPaths: [denyFile] },
    ).wrapCommand("true");
    const viaInteractive = interactiveWrapCommand({
      mode: "workspace-write",
      detect: present,
      denyReadPaths: [denyFile],
    })("true", workDir);
    const viaFactory = createSandboxBackend({
      mode: "workspace-write",
      workDir,
      detect: present,
      denyReadPaths: [denyFile],
    });

    for (const wrapped of [viaClass, viaInteractive]) {
      expect(wrapped).toContain("/dev/null");
      expect(wrapped).toContain(denyFile);
    }
    expect(viaFactory).toBeInstanceOf(LinuxSandbox);
    expect((viaFactory as LinuxSandbox).wrapCommand("true")).toContain(`'/dev/null' '${denyFile}'`);
  });

  it("fails_closed_without_confinement", () => {
    const opts = { denyReadPaths: [denyFile] };
    // bwrap absent: a deny list never degrades to an unconfined run
    expect(() =>
      createSandboxBackend({
        mode: "workspace-write",
        workDir,
        detect: absent,
        warn: quiet,
        ...opts,
      }),
    ).toThrow(SandboxNotAvailableError);
    expect(() =>
      interactiveWrapCommand({ mode: "workspace-write", detect: absent, warn: quiet, ...opts })(
        "true",
        workDir,
      ),
    ).toThrow(SandboxNotAvailableError);
    // danger-full-access applies no sandbox, so no mask can be honoured
    expect(() =>
      createSandboxBackend({ mode: "danger-full-access", workDir, detect: present, ...opts }),
    ).toThrow(TypeError);
    expect(() =>
      interactiveWrapCommand({ mode: "danger-full-access", detect: present, ...opts })(
        "true",
        workDir,
      ),
    ).toThrow(TypeError);
    // an empty list keeps today's behaviour: the fallback to LocalSandbox
    expect(
      createSandboxBackend({
        mode: "workspace-write",
        workDir,
        detect: absent,
        warn: quiet,
        denyReadPaths: [],
      }),
    ).toBeInstanceOf(LocalSandbox);
  });

  itLive("denies_a_file_and_a_directory_inside_the_sandbox_and_reads_them_outside", async () => {
    const config = { workDir, timeoutMs: 10_000 };
    const confined = new LinuxSandbox(config, {
      mode: "workspace-write",
      denyReadPaths: [denyFile, denyDir],
    });
    const open = new LocalSandbox(config);
    const inner = path.join(denyDir, "inner.txt");

    const fileIn = await confined.execute(`cat ${denyFile}`);
    const dirIn = await confined.execute(`cat ${inner}`);
    const fileOut = await open.execute(`cat ${denyFile}`);
    const dirOut = await open.execute(`cat ${inner}`);

    expect(fileIn.exitCode).not.toBe(0);
    expect(fileIn.stdout).not.toContain("TOKEN-VALUE");
    expect(dirIn.exitCode).not.toBe(0);
    expect(dirIn.stdout).not.toContain("INNER-VALUE");
    expect(fileOut.exitCode).toBe(0);
    expect(fileOut.stdout).toContain("TOKEN-VALUE");
    expect(dirOut.exitCode).toBe(0);
  });
});
