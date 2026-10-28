/**
 * M75 T2.2 — `LinuxSandbox` + the wrap + the posture, promoted from agent-builder.
 *
 * ## Why it fits the contract without breaking it
 *
 * `SandboxBackend` declares exactly 2 abstracts (`execute`, `uploadFile`); `readFile`/`writeFile`/
 * `glob`/`grep` are concrete over `execute`. `LinuxSandbox` only does `override execute` — the method
 * **already abstract** — and **adds** `wrapCommand`. No member is missing, so promoting forces no major.
 *
 * ## What these tests protect, which is not obvious
 *
 * This subsystem's value is not in confining when things go right — it is in **NEVER pretending**
 * when they go wrong. Three honest-degradation paths are tested here as negative cases, asserting
 * the specific error/warning rather than "it did not throw": bwrap absent, `danger-full-access` (an
 * explicit opt-out, which is NOT an anomaly and therefore does not warn), and a non-x86_64
 * architecture (where the cBPF filter would kill every syscall).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  allowlistedEnv,
  type BwrapDetection,
  buildSeccompFilter,
  createSandboxBackend,
  LinuxSandbox,
  resolveSandboxPosture,
  SandboxBackend,
  seccompPathForArch,
  wrapCommandForSandbox,
} from "../src/sandbox/index.js";
// By explicit module path, not through the barrel: these are test seams and the package keeps them
// out of its public surface (see the note at the foot of src/sandbox/index.ts).
import { __resetSandboxWarnLatchForTests } from "../src/sandbox/linux-sandbox.js";

const detectOk = (): BwrapDetection => ({ ok: true, bin: "/usr/bin/bwrap" });
const detectFailure = (): BwrapDetection => ({ ok: false, reason: "bwrap not found in PATH" });

describe("M75 T2.2 — wrapCommandForSandbox", () => {
  it("test_it_wraps_with_bwrap_and_preserves_the_quoted_command", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", network: false, env: {}, bin: "/usr/bin/bwrap" },
      "echo 'oi'",
    );
    expect(w).not.toBeNull();
    // The command crosses ONE extra `/bin/sh -c`: the quoting must survive, otherwise a command with
    // single quotes would become a different command inside the sandbox.
    expect(w).toContain("/bin/sh -c");
    expect(w).toContain("--unshare-net");
  });

  it("test_danger_full_access_returns_null", () => {
    // `null` = "do not wrap". Returning the raw command would conflate the two in the caller.
    expect(
      wrapCommandForSandbox("danger-full-access", { cwd: "/w", env: {} }, "echo oi"),
    ).toBeNull();
  });

  it("test_seccomp_only_goes_in_when_there_is_a_path", () => {
    const withoutSeccomp = wrapCommandForSandbox("workspace-write", { cwd: "/w", env: {} }, "true");
    const com = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/tmp/f.bpf" },
      "true",
    );
    expect(withoutSeccomp).not.toContain("--seccomp");
    // The program comes in via an fd 3 redirect — that is how bwrap reads it.
    expect(com).toContain("--seccomp");
    expect(com).toContain("3< ");
  });
});

/**
 * B-600 — the program route. The seccomp program travels to bwrap's fd 3 through a pipe fed from
 * memory, so no file exists that a confined command could replace for a later one.
 */
describe("B-600 — seccompProgram: the program piped from memory", () => {
  // Bytes 000 and 377, and a digit right after an escape: `\000` followed by `1` must stay two bytes.
  const PROGRAM = Buffer.from([
    0, 0x31, 0xff, 0x7f, 6, 0, 0, 0, 0, 0, 0, 0, 0x20, 0x0a, 0x27, 0x5c,
  ]);

  /** The octal escapes of the printf the wrap emits, as `/bin/sh` will read them. */
  function printfArgumentOf(wrap: string): string {
    // The pipeline is one argument of `exec /bin/sh -c`, so its own quotes appear as `'\''`.
    const m = /printf '\\''((?:\\[0-7]{3})+)'\\''/.exec(wrap);
    if (m === null) throw new Error(`no octal printf argument in the wrap: ${wrap}`);
    return m[1] as string;
  }

  it("test_seccomp_program_printf_argument_decodes_to_the_program_bytes", () => {
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: "/usr/bin/bwrap", seccompProgram: PROGRAM },
      "true",
    )!;
    const decoded = execFileSync("/bin/sh", ["-c", `printf '${printfArgumentOf(wrap)}'`]);
    expect(Buffer.compare(decoded, PROGRAM), `decoded ${decoded.toString("hex")}`).toBe(0);
  });

  it("test_seccomp_program_costs_four_characters_per_byte", () => {
    const program = buildSeccompFilter({ networkRestricted: true });
    const opts = { cwd: "/w", env: {}, bin: "/usr/bin/bwrap" };
    const plain = wrapCommandForSandbox("workspace-write", opts, "true")!;
    const piped = wrapCommandForSandbox(
      "workspace-write",
      { ...opts, seccompProgram: program },
      "true",
    )!;
    expect(piped.length).toBeLessThanOrEqual(4 * program.length + 2 * plain.length + 64);
  });

  it("test_no_host_path_in_the_linux_sandbox_wrap", () => {
    const s = new LinuxSandbox(
      { workDir: "/w" },
      { mode: "workspace-write", bin: "/usr/bin/bwrap", env: {} },
    );
    const w = s.wrapCommand("true")!;
    expect(w, "the wrap must not read the program from a host file").not.toMatch(/3< /);
    expect(w).not.toContain(".bpf");
    expect(w).not.toContain("ab-seccomp-");
    if (process.arch === "x64")
      expect(w, "the filter must still be installed").toContain("--seccomp");
  });

  it("test_seccomp_program_wins_over_seccomp_path", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/x/f.bpf", seccompProgram: PROGRAM },
      "true",
    )!;
    expect(w, "with both given the path must be ignored").not.toContain("/x/f.bpf");
    expect(w).not.toMatch(/3< /);
    expect(w).toContain("printf");
  });

  it("test_seccomp_program_rejects_a_length_that_is_not_a_positive_multiple_of_8", () => {
    const wrapWith = (program: Buffer) => () =>
      wrapCommandForSandbox(
        "workspace-write",
        { cwd: "/w", env: {}, seccompProgram: program },
        "true",
      );
    expect(wrapWith(Buffer.alloc(0))).toThrow(TypeError);
    expect(wrapWith(Buffer.alloc(0))).toThrow(
      "seccompProgram must be a positive multiple of 8 bytes, got 0",
    );
    expect(wrapWith(Buffer.alloc(7))).toThrow(
      "seccompProgram must be a positive multiple of 8 bytes, got 7",
    );
  });

  it("test_a_non_x64_architecture_refuses_the_seccomp_program_and_warns", async () => {
    // Its own warn-once latch: a shared one would make this test silence the path route's test below.
    const { seccompProgramForArch } = await import("../src/sandbox/seccomp-delivery.js");
    const warnings: string[] = [];
    expect(seccompProgramForArch("arm64", (m) => warnings.push(m))).toBeUndefined();
    expect(seccompProgramForArch("arm64", (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/x86_64|x64/i);
    expect(seccompProgramForArch("x64", () => {})?.length).toBeGreaterThan(0);
  });

  /** A stand-in for bwrap: skips its flags up to `--`, drains fd 3, then runs the command. */
  function fakeBwrap(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "b600-fake-bwrap-"));
    const bin = path.join(dir, "bwrap");
    writeFileSync(
      bin,
      '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\ncat <&3 >/dev/null\nexec "$@"\n',
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("test_seccomp_program_wrap_keeps_a_single_quote", () => {
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: fakeBwrap(), seccompProgram: PROGRAM },
      `printf %s "it's"`,
    )!;
    expect(execFileSync("/bin/sh", ["-c", wrap], { input: "" }).toString()).toBe("it's");
  });

  it("test_seccomp_program_wrap_keeps_stdin_and_the_exit_status", () => {
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: fakeBwrap(), seccompProgram: PROGRAM },
      "cat; exit 7",
    )!;
    const r = spawnSync("/bin/sh", ["-c", wrap], { input: "piped-input" });
    expect(r.stdout.toString(), "the command's stdin must be the caller's, not the program").toBe(
      "piped-input",
    );
    expect(r.status).toBe(7);
  });
});

/**
 * B-600 — the deprecated path route. A consumer still passing `seccompPath` gets the filter bound
 * read-only on top of every writable bind, so a confined command cannot overwrite it or rename its
 * directory away. Where the directory is a writable root or contains one, only the file is bound,
 * so the workspace stays writable.
 */
describe("B-600 — seccompPath: the filter bound read-only", () => {
  const indexOfBind = (w: string, target: string): number =>
    w.indexOf(`'--ro-bind' '${target}' '${target}'`);

  it("test_seccomp_path_dir_is_read_only_after_every_writable_bind", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/tmp/ab-seccomp-X/filter.bpf" },
      "true",
    )!;
    const bind = indexOfBind(w, "/tmp/ab-seccomp-X");
    expect(bind, "the filter's directory must be bound read-only").toBeGreaterThan(-1);
    expect(bind, "after the writable /tmp bind, or /tmp would cover it").toBeGreaterThan(
      w.lastIndexOf("'--bind'"),
    );
    expect(bind, "before bwrap's `--`").toBeLessThan(w.indexOf("'--chdir'"));
  });

  it("test_seccomp_path_in_an_ancestor_of_the_workspace_binds_the_file", () => {
    // `/x.bpf`: its directory is `/`, an ancestor of the workspace. Binding `/` read-only would
    // take the workspace's write access away, so only the file is bound.
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/home/u/proj", env: {}, seccompPath: "/x.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/x.bpf")).toBeGreaterThan(w.lastIndexOf("'--bind'"));
    expect(w.match(/'--ro-bind' '\/' '\/'/g), "`/` must stay bound only once, first").toHaveLength(
      1,
    );
    expect(w.endsWith(" 3< '/x.bpf'")).toBe(true);
  });

  it("test_seccomp_path_directly_in_tmp_binds_the_file", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/tmp/f.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/tmp/f.bpf")).toBeGreaterThan(w.lastIndexOf("'--bind'"));
    expect(indexOfBind(w, "/tmp"), "/tmp must stay writable").toBe(-1);
  });

  it("test_seccomp_path_under_read_only_binds_the_directory", () => {
    // read-only has no writable root, so nothing stops the directory itself being bound.
    const w = wrapCommandForSandbox(
      "read-only",
      { cwd: "/w", env: {}, seccompPath: "/tmp/ab-seccomp-X/filter.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/tmp/ab-seccomp-X")).toBeLessThan(w.indexOf("'--chdir'"));
    expect(indexOfBind(w, "/tmp/ab-seccomp-X")).toBeGreaterThan(-1);
  });

  it("test_seccomp_path_inside_the_workspace_binds_the_file", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/w/filter.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/w/filter.bpf")).toBeGreaterThan(w.lastIndexOf("'--bind'"));
    expect(indexOfBind(w, "/w"), "the workspace must stay writable").toBe(-1);
  });
});

describe("M75 T2.2 — allowlistedEnv", () => {
  it("test_reinjects_only_what_is_allowed_and_discards_the_rest", () => {
    // Codex's env_clear model: the child gets what it needs to run a shell, never the parent's env
    // — which may hold a secret under a name no name-based heuristic catches.
    const env = allowlistedEnv({ PATH: "/bin", MY_ODDLY_NAMED_KEY: "s3cr3t", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(Object.values(env)).not.toContain("s3cr3t");
  });
});

describe("M75 T2.2 — LinuxSandbox", () => {
  it("test_it_is_a_sandbox_backend_of_the_contract", () => {
    const s = new LinuxSandbox(
      { workDir: "/w" },
      { mode: "workspace-write", bin: "/usr/bin/bwrap" },
    );
    expect(s).toBeInstanceOf(SandboxBackend);
  });

  it("test_the_objects_wrap_command_uses_the_mode_it_was_built_with", () => {
    const s = new LinuxSandbox(
      { workDir: "/w" },
      { mode: "workspace-write", bin: "/usr/bin/bwrap" },
    );
    expect(s.wrapCommand("true")).toContain("--unshare-net");

    const livre = new LinuxSandbox({ workDir: "/w" }, { mode: "danger-full-access" });
    expect(livre.wrapCommand("true")).toBeNull();
  });
});

describe("M75 T2.2 — honest degradation (negative cases)", () => {
  it("test_absent_bwrap_warns_ONCE_and_returns_an_unconfined_backend", () => {
    __resetSandboxWarnLatchForTests();
    const warnings: string[] = [];
    const opts = {
      mode: "workspace-write" as const,
      detect: detectFailure,
      warn: (m: string) => warnings.push(m),
    };
    const a = createSandboxBackend(opts);
    const b = createSandboxBackend(opts);

    expect(a).toBeInstanceOf(SandboxBackend);
    expect(b).toBeInstanceOf(SandboxBackend);
    // Neither is a LinuxSandbox: without bwrap there is no confinement, and pretending would be the worst outcome.
    expect(a).not.toBeInstanceOf(LinuxSandbox);
    // ONCE: the warning is for the human, and repeating it on every tool call becomes noise nobody reads.
    expect(warnings, "the warning repeated — it becomes noise and stops being read").toHaveLength(
      1,
    );
    expect(warnings[0], "the warning must say WHY and in which mode").toMatch(
      /PATH.*workspace-write/s,
    );
  });

  it("test_danger_full_access_does_not_warn_because_it_is_an_explicit_opt_out", () => {
    __resetSandboxWarnLatchForTests();
    const warnings: string[] = [];
    const s = createSandboxBackend({
      mode: "danger-full-access",
      detect: detectFailure,
      warn: (m: string) => warnings.push(m),
    });
    expect(s).not.toBeInstanceOf(LinuxSandbox);
    // The distinction that matters: "the user turned it off" is not an anomaly; "I could not turn it on" is.
    expect(warnings, "an explicit opt-out is not an anomaly and must not warn").toHaveLength(0);
  });

  it("test_a_non_x64_architecture_refuses_seccomp_and_warns", () => {
    // ARCH GUARD: the cBPF program is x86_64 and its guard KILLS every syscall from another
    // architecture — the first execve would die, and silently, because generation works and bwrap
    // accepts it.
    const warnings: string[] = [];
    const p = seccompPathForArch("arm64", (m) => warnings.push(m));
    expect(p, "on arm64 no seccomp path may be returned").toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/x86_64|x64/i);
  });
});

describe("M75 T2.2 — resolveSandboxPosture", () => {
  it("test_confined_reports_kernel", () => {
    const p = resolveSandboxPosture({ mode: "workspace-write", detect: detectOk });
    expect(p.enforced).toBe(true);
    expect(p.detail).toMatch(/kernel/i);
  });

  it("test_without_bwrap_it_says_not_confined_WITH_the_reason", () => {
    // The posture is what the UI shows. "not confined" without a reason leaves the user with no action; with the
    // reason they know whether to install bwrap or whether they changed mode.
    const p = resolveSandboxPosture({ mode: "workspace-write", detect: detectFailure });
    expect(p.enforced).toBe(false);
    expect(p.detail).toContain("PATH");
  });

  it("test_danger_full_access_is_honestly_not_confined", () => {
    const p = resolveSandboxPosture({ mode: "danger-full-access", detect: detectOk });
    expect(p.enforced, "danger-full-access may never report confinement").toBe(false);
  });
});
