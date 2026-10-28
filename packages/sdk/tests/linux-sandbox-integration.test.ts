// MIGRATED from agent-builder in M75 T4.1. The plan's rule (D4) is that the tests cross over WITHOUT
// assertion rewriting: if a test had to change in order to pass, that would be a FINDING, not an adjustment — and
// and is the only defence against silently loosening a security guarantee during a migration.
//
// Changes permitted and actually made: the `import` lines and the class name
// (BwrapSandbox -> LinuxSandbox). No test body, no assertion.
//
// These are the 10 `itLive` tests proving REAL confinement via execute(): it blocks writes outside the
// workspace, allows in cwd, blocks the network, .git read-only, quotes survive the double shell, seccomp
// blocks ptrace and AF_INET but allows AF_UNIX. They had never run in CI until M75.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  allowlistedEnv,
  buildSeccompFilter,
  createSandboxBackend,
  detectBwrap,
  LinuxSandbox,
  LocalSandbox,
  realProbes,
  seccompPathForArch,
  wrapCommandForSandbox,
} from "../src/sandbox/index.js";

/**
 * M53 T0.2 — LinuxSandbox: kernel-enforced execute() via bubblewrap, honoring the SandboxBackend
 * contract. Integration tests run against the REAL bwrap when present (this host has 0.6.1);
 * skipped honestly elsewhere. Fallback path is always tested (injectable detection).
 */

const HAS_BWRAP = detectBwrap(realProbes).ok;
const itLive = HAS_BWRAP ? it : it.skip;

const workDir = mkdtempSync(path.join(tmpdir(), "m53-sbx-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("LinuxSandbox (real integration with bwrap)", () => {
  itLive("execute_blocks_write_outside_workspace", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 10_000 }, { mode: "workspace-write" });
    const r = await sbx.execute("touch /usr/m53-should-fail");
    expect(r.exitCode).not.toBe(0); // kernel EROFS, not tool-gating
    expect(existsSync("/usr/m53-should-fail")).toBe(false);
  });

  itLive("execute_allows_write_in_cwd", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 10_000 }, { mode: "workspace-write" });
    const r = await sbx.execute("touch ./m53-ok.txt && echo WROTE");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("WROTE");
    expect(existsSync(path.join(workDir, "m53-ok.txt"))).toBe(true);
  });

  itLive("execute_blocks_network_and_signals_child", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 10_000 }, { mode: "workspace-write" });
    // an empty /proc/net/route or a failing curl proves the namespace; the Codex flag signals the child (spawn.rs:20,79)
    const r = await sbx.execute(
      'echo "flag=$CODEX_SANDBOX_NETWORK_DISABLED"; curl -sm 2 https://example.com >/dev/null 2>&1 && echo NET-LEAK || echo NET-BLOCKED',
    );
    expect(r.stdout).toContain("flag=1");
    expect(r.stdout).toContain("NET-BLOCKED");
    expect(r.stdout).not.toContain("NET-LEAK");
  });

  itLive("read_only_blocks_write_even_in_cwd", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 10_000 }, { mode: "read-only" });
    const r = await sbx.execute("touch ./m53-ro.txt");
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(path.join(workDir, "m53-ro.txt"))).toBe(false);
  });

  itLive("git_dir_is_read_only_under_workspace_write", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 10_000 }, { mode: "workspace-write" });
    await sbx.execute("mkdir -p .git"); // .git did not exist in the mkdtemp — created outside the protection test
    // a new instance re-evaluates gitDirExists at execute time
    const r = await sbx.execute("touch .git/m53-hook");
    expect(r.exitCode).not.toBe(0); // permissions.rs:22-31 — .git RO on top of the RW bind
  });

  itLive("quotes_survive_the_double_shell", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 10_000 }, { mode: "workspace-write" });
    // inner single quotes + literal metacharacters must cross the extra `/bin/sh -c` intact
    const r = await sbx.execute(`printf '%s' 'a"b\`c$d' && printf '%s' " e'f"`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("a\"b`c$d e'f");
  });
});

describe("createSandboxBackend (honest fallback)", () => {
  it("fallback_local_when_unavailable_warns_once", () => {
    const warns: string[] = [];
    const make = () =>
      createSandboxBackend({
        mode: "workspace-write",
        workDir,
        detect: () => ({ ok: false, reason: "bwrap not found in PATH" }),
        warn: (m) => warns.push(m),
      });
    expect(make()).toBeInstanceOf(LocalSandbox);
    expect(make()).toBeInstanceOf(LocalSandbox);
    expect(warns.length).toBe(1); // WARN once (Codex MISSING_BWRAP_WARNING pattern)
    expect(warns[0]).toMatch(/bwrap not found/);
  });

  it("danger_mode_uses_local_without_warn", () => {
    const warns: string[] = [];
    const b = createSandboxBackend({
      mode: "danger-full-access",
      workDir,
      detect: () => ({ ok: true, bin: "/usr/bin/bwrap" }),
      warn: (m) => warns.push(m),
    });
    expect(b).toBeInstanceOf(LocalSandbox);
    expect(b).not.toBeInstanceOf(LinuxSandbox);
    expect(warns).toEqual([]); // an explicit opt-out is not an anomaly
  });

  it("available_returns_bwrap_backend", () => {
    const b = createSandboxBackend({
      mode: "workspace-write",
      workDir,
      detect: () => ({ ok: true, bin: "/usr/bin/bwrap" }),
      warn: () => {},
    });
    expect(b).toBeInstanceOf(LinuxSandbox);
  });
});

describe("M53 review fixes — MEDIUM-1 absolute bin + MEDIUM-2 posture", () => {
  it("execute_uses_absolute_bin_from_detection", () => {
    // MEDIUM-1: the validated absolute bin (anti-hijack) MUST be the one executed, not PATH's `bwrap`
    const sbx = new LinuxSandbox(
      { workDir: "/home/u/proj" },
      { mode: "workspace-write", bin: "/opt/trusted/bwrap" },
    );
    const wrapped = (sbx as unknown as { wrapCommand(c: string): string }).wrapCommand("echo hi");
    // B-600: on x86_64 the bwrap call sits inside the `exec /bin/sh -c '<pipeline>'` that pipes the
    // seccomp program, one quoting level deeper; read it at its own level. The bin is still the
    // first word bwrap's process runs.
    const bwrapLevel = wrapped.replaceAll("'\\''", "'");
    if (process.arch === "x64") {
      expect(wrapped.startsWith("exec /bin/sh -c ")).toBe(true); // absolute: no PATH lookup
      expect(bwrapLevel.split("| exec '/opt/trusted/bwrap' ")).toHaveLength(2);
    } else {
      expect(wrapped.startsWith("'/opt/trusted/bwrap' ")).toBe(true);
    }
    expect(wrapped).not.toMatch(/(^|\s)bwrap\s/); // never the bare name
  });

  it("resolveSandboxPosture_reports_enforced_and_downgrade", async () => {
    const { resolveSandboxPosture } = await import("../src/sandbox/index.js");
    const on = resolveSandboxPosture({
      mode: "workspace-write",
      detect: () => ({ ok: true, bin: "/usr/bin/bwrap" }),
    });
    expect(on).toEqual({ mode: "workspace-write", enforced: true, detail: "kernel (bwrap)" });

    const off = resolveSandboxPosture({
      mode: "workspace-write",
      detect: () => ({ ok: false, reason: "bwrap not found in PATH" }),
    });
    expect(off.enforced).toBe(false);
    expect(off.detail).toMatch(/tool-gating only/);
    expect(off.detail).toMatch(/bwrap not found/);

    const danger = resolveSandboxPosture({
      mode: "danger-full-access",
      detect: () => ({ ok: true, bin: "/usr/bin/bwrap" }),
    });
    expect(danger.enforced).toBe(false);
    expect(danger.detail).toMatch(/no confinement/);
  });
});

describe("M63 — seccomp via bwrap --seccomp (REAL integration)", () => {
  const wd = mkdtempSync(path.join(tmpdir(), "m63-"));
  afterAll(() => rmSync(wd, { recursive: true, force: true }));

  itLive("seccomp_blocks_ptrace", async () => {
    const sbx = new LinuxSandbox({ workDir: wd, timeoutMs: 10_000 }, { mode: "workspace-write" });
    // strace uses ptrace(PTRACE_TRACEME) -> EPERM under the filter.
    // `LC_ALL=C` pins the locale: strace's message is localized, so without it this assertion
    // depended on the host's language and only passed by also matching the translation.
    const r = await sbx.execute("LC_ALL=C strace /bin/true 2>&1 | head -3");
    expect(r.stdout.toLowerCase()).toMatch(/not permitted|operation not permitted|eperm/);
  });

  itLive("seccomp_blocks_socket_af_inet_but_allows_af_unix", async () => {
    const sbx = new LinuxSandbox({ workDir: wd, timeoutMs: 10_000 }, { mode: "workspace-write" });
    // python3: AF_INET socket → PermissionError(EPERM); AF_UNIX socket → OK
    const probe =
      'python3 -c "import socket,os\n' +
      'try:\n socket.socket(socket.AF_INET, socket.SOCK_STREAM); print(\\"INET-OK\\")\n' +
      'except OSError as e: print(\\"INET-DENIED\\", e.errno)\n' +
      'try:\n socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); print(\\"UNIX-OK\\")\n' +
      'except OSError as e: print(\\"UNIX-DENIED\\", e.errno)"';
    const r = await sbx.execute(probe);
    expect(r.stdout).toContain("INET-DENIED"); // AF_INET denied (EPERM=1)
    expect(r.stdout).toContain("UNIX-OK"); // AF_UNIX allowed
  });

  itLive("normal_command_still_runs_under_seccomp", async () => {
    const sbx = new LinuxSandbox({ workDir: wd, timeoutMs: 10_000 }, { mode: "workspace-write" });
    const r = await sbx.execute(
      "echo SECCOMP-OK && touch ./f.txt && cat ./f.txt >/dev/null && echo WROTE",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("SECCOMP-OK");
    expect(r.stdout).toContain("WROTE");
  });

  itLive("read_only_mode_also_installs_seccomp", async () => {
    const sbx = new LinuxSandbox({ workDir: wd, timeoutMs: 10_000 }, { mode: "read-only" });
    const r = await sbx.execute("LC_ALL=C strace /bin/true 2>&1 | head -2");
    expect(r.stdout.toLowerCase()).toMatch(/not permitted|eperm/);
  });

  it("danger_full_access_has_no_seccomp", () => {
    const sbx = new LinuxSandbox({ workDir: wd }, { mode: "danger-full-access" });
    expect(sbx.wrapCommand("echo x")).toBeNull(); // bwrap skipped entirely
  });

  // The seccomp program is x86_64 only; elsewhere the wrap carries no filter at all.
  (process.arch === "x64" ? it : it.skip)(
    "wrapCommand_workspace_write_has_seccomp_flag_and_pipe",
    () => {
      // B-600: this used to pin `3< '<file>.bpf'`, the host file a confined command could replace.
      // The program now reaches fd 3 through a pipe fed from memory.
      const sbx = new LinuxSandbox({ workDir: wd }, { mode: "workspace-write" });
      const w = sbx.wrapCommand("echo x");
      expect(w).not.toBeNull();
      expect(w).toContain("'\\''--seccomp'\\'' '\\''3'\\''");
      expect(w).toContain("3<&0 0<&4 4<&-");
      expect(w).not.toMatch(/3< '.*\.bpf'/);
    },
  );
});

describe("M57 T0.1 — wrapCommandForSandbox (pure function, single source of the wrap)", () => {
  it("workspace_write_produces_bwrap_seccomp_redirect", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/home/u/proj", seccompPath: "/x.bpf", bin: "bwrap" },
      "echo hi",
    )!;
    expect(w.startsWith("'bwrap' ")).toBe(true);
    expect(w).toContain("'--seccomp' '3'");
    expect(w.endsWith("/bin/sh -c 'echo hi' 3< '/x.bpf'")).toBe(true);
  });

  it("danger_full_access_returns_null", () => {
    expect(
      wrapCommandForSandbox("danger-full-access", { cwd: "/home/u/proj" }, "echo x"),
    ).toBeNull();
  });

  it("no_seccomp_path_omits_flag_and_redirect", () => {
    const w = wrapCommandForSandbox(
      "read-only",
      { cwd: "/home/u/proj", bin: "/usr/bin/bwrap" },
      "ls",
    )!;
    expect(w).not.toContain("--seccomp");
    expect(w).not.toMatch(/3</);
    expect(w).toContain("/bin/sh -c 'ls'");
  });

  it("LinuxSandbox_wrapCommand_delegates_byte_identical", () => {
    // the instance's output MUST match the pure function's with the same fields (proves delegation).
    // an explicit env is injected so the test is deterministic (the default allowlistedEnv() varies per host).
    const env = { PATH: "/usr/bin", HOME: "/home/u" };
    const sbx = new LinuxSandbox(
      { workDir: "/home/u/proj" },
      { mode: "workspace-write", bin: "/opt/bwrap", env },
    );
    const viaInstance = (sbx as unknown as { wrapCommand(c: string): string }).wrapCommand(
      "echo x",
    );
    // B-600: the instance pipes the memoized program instead of naming a file, so the pure function
    // is given the same bytes rather than a path parsed out of a `3<` redirect.
    const seccompProgram =
      process.arch === "x64" ? buildSeccompFilter({ networkRestricted: true }) : undefined;
    const viaPure = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/home/u/proj", network: false, bin: "/opt/bwrap", env, seccompProgram },
      "echo x",
    );
    expect(viaInstance).toBe(viaPure);
  });
});

describe("B-600 — the deprecated seccompPath route binds the filter read-only", () => {
  // Live: a consumer composing its own wrap with `seccompPath`. The confined command tries every
  // route a writable root offers; the read-only bind must refuse each, and the file keep its bytes.
  // x86_64 only: the filter it feeds bwrap is the x86_64 program, which kills every other arch.
  (HAS_BWRAP && process.arch === "x64" ? it : it.skip)(
    "the_seccomp_filter_cannot_be_written_from_inside_the_sandbox",
    async () => {
      const detection = detectBwrap(realProbes);
      if (!detection.ok) throw new Error(`bwrap vanished mid-run: ${detection.reason}`);
      const filter = seccompPathForArch("x64", () => {})!;
      const dir = path.dirname(filter);
      try {
        const before = readFileSync(filter);
        const q = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`;
        const attack =
          `(printf 'x' > ${q(filter)}) 2>/dev/null && echo OVERWRITE-OK || echo OVERWRITE-REFUSED; ` +
          `(mv ${q(dir)} ${q(`${dir}.moved`)}) 2>/dev/null && echo RENAME-OK || echo RENAME-REFUSED`;
        const wrapped = wrapCommandForSandbox(
          "workspace-write",
          { cwd: workDir, env: allowlistedEnv(), bin: detection.bin, seccompPath: filter },
          attack,
        )!;
        const r = await new LocalSandbox({ workDir, timeoutMs: 10_000 }).execute(wrapped);

        expect(r.stdout).toContain("OVERWRITE-REFUSED");
        expect(r.stdout).toContain("RENAME-REFUSED");
        expect(existsSync(`${dir}.moved`)).toBe(false);
        expect(Buffer.compare(readFileSync(filter), before), "the filter's bytes changed").toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(`${dir}.moved`, { recursive: true, force: true });
      }
    },
  );
});

describe("M63 review HIGH — no brick on non-x86_64 arch", () => {
  it("non_x64_arch_skips_seccomp_and_warns (honest fallback, never a brick)", () => {
    const warns: string[] = [];
    // aarch64: generating the x86_64 filter would kill EVERY syscall -> it must skip (undefined), never brick
    expect(seccompPathForArch("arm64", (m) => warns.push(m))).toBeUndefined();
    expect(seccompPathForArch("ppc64", () => {})).toBeUndefined(); // any non-x64
    // x64: emits normally (the .bpf path)
    const p = seccompPathForArch("x64", () => {});
    expect(typeof p).toBe("string");
    expect(p).toMatch(/\.bpf$/);
  });
});

describe("#385 — a command that spawns a child keeps the PARENT's stdout", () => {
  // The user-visible half of the seccomp fix. `seccomp-fd-syscalls.test.ts` pins the filter's
  // shape; this proves the shape was the right one, against the real kernel.
  itLive("execute_keeps_parent_stdout_when_the_command_spawns_a_child", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 30_000 }, { mode: "workspace-write" });

    const r = await sbx.execute(
      `node -e "console.log('PARENT-MARKER'); require('child_process').spawnSync('echo',['CHILD-MARKER'],{stdio:'inherit'})"`,
    );

    // Before the fix the parent's line was gone and the child's survived: the parent was killed
    // mid-flight by the filter, so its buffered pipe write never flushed, while the child's bytes
    // had already reached the inherited fd.
    expect(r.stdout).toContain("PARENT-MARKER");
    expect(r.stdout).toContain("CHILD-MARKER");
    expect(r.exitCode).toBe(0);
  });
});
