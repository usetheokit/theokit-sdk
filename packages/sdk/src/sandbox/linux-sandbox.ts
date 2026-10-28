// Promoted from agent-builder in M75 (plan m75-sandbox-kernel-no-framework, D1). Renamed from
// `BwrapSandbox` to `LinuxSandbox`: bwrap is the IMPLEMENTATION, Linux is the contract — swapping the
// mechanism (landlock, for example) should not change the name the consumer imports.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { redactSecrets } from "../internal/security/redact.js";
import type { BwrapDetection, SandboxMode } from "./bwrap.js";
import { buildBwrapArgv, detectBwrapMemoized } from "./bwrap.js";
import { LocalSandbox } from "./local-sandbox.js";
import { buildSeccompFilter } from "./seccomp.js";
import {
  nonX64SeccompWarning,
  rememberSeccompFile,
  restrictedSeccompProgram,
  wrapWithSeccompPath,
  wrapWithSeccompProgram,
} from "./seccomp-delivery.js";
import { shellEscapePosix } from "./shell-escape.js";
import type { SandboxBackend, SandboxConfig } from "./types.js";

/*
 * M53 — kernel-enforced sandbox backend, injected into `createShellTool({ sandbox })`.
 *
 * `LinuxSandbox extends LocalSandbox` and only REWRITES the command: `<bwrap-bin> <policy flags> --
 * /bin/sh -c '<original>'`. Everything else (spawn, output caps, timeout, ExecuteResult shape, file
 * ops) is inherited — the SDK backend stays the single execution engine. Mirrors Codex's
 * `SandboxManager::transform` (argv prefixing before spawn, never in-process).
 */

/**
 * M57 — the single source of truth for the sandbox command wrap. Turns `command` into
 * `<bin> <bwrap flags> [--seccomp 3] -- /bin/sh -c '<command>' [3< <bpf>]`, or `null` when the policy
 * skips the sandbox (`danger-full-access`). Extracted from `LinuxSandbox.wrapCommand` so the interactive
 * PTY backend (M57) can reuse the EXACT wrap the one-shot `run_shell` already uses (DRY) — faithful to
 * Codex, where the sandbox transforms the argv before the PTY spawns it (`sandboxing/src/manager.rs:321`).
 */
export function wrapCommandForSandbox(
  mode: SandboxMode,
  opts: {
    cwd: string;
    network?: boolean;
    env?: Record<string, string>;
    bin?: string;
    /**
     * @deprecated Pass `seccompProgram`: a confined command may replace a file before a later one
     * loads it (B-600). A path `seccompPathForArch` or `restrictedSeccompPath` returned is piped
     * from the bytes this process wrote; any other path is read from the file, bound read-only (see
     * `wrapWithSeccompPath` for what that leaves open). Ignored when `seccompProgram` is given.
     */
    seccompPath?: string;
    /**
     * The cBPF seccomp program, piped to bwrap's fd 3 from memory so no file holds it. Must be a
     * positive multiple of 8 bytes (a `TypeError` otherwise). Wins over `seccompPath`.
     */
    seccompProgram?: Uint8Array;
  },
  command: string,
): string | null {
  const argv = buildBwrapArgv(mode, { cwd: opts.cwd, network: opts.network, env: opts.env });
  if (argv === null) return null; // danger-full-access: bwrap skipped
  const bin = opts.bin ?? "bwrap";
  if (opts.seccompProgram !== undefined) {
    return wrapWithSeccompProgram([bin, ...argv.slice(0, -1)], command, opts.seccompProgram);
  }
  if (opts.seccompPath === undefined) {
    return `${[bin, ...argv].map(shellEscapePosix).join(" ")} /bin/sh -c ${shellEscapePosix(command)}`;
  }
  return wrapWithSeccompPath([bin, ...argv], { mode, cwd: opts.cwd }, command, opts.seccompPath);
}

/**
 * Env allowlist re-injected inside the sandbox after `--clearenv`. Codex env_clear model: the child
 * gets exactly what it needs to run a shell, never the parent's full env (which may hold oddly-named
 * secrets the SDK name-pattern scrub misses). `CODEX_SANDBOX_NETWORK_DISABLED` is added by the argv
 * builder when network is unshared.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "TMPDIR",
  "SHELL",
];

/**
 * Build the environment a confined command runs with after `--clearenv`: `PATH`, `HOME`, `LANG`,
 * `LC_ALL`, `LC_CTYPE`, `TERM`, `USER`, `TMPDIR` and `SHELL`, copied from `source` (default
 * `process.env`) and omitted where unset.
 *
 * The allowlist shape is the point, and it is what separates this from the other env control in the
 * package. `SandboxConfig.env: "inherit-scrubbed"` is a denylist: it drops variables whose NAME looks
 * secret-ish, so an oddly named secret survives. Here the child gets these nine names and nothing
 * else, and a secret's name stops mattering.
 *
 * Call it when you compose the wrap yourself and need an `env` for `wrapCommandForSandbox`;
 * {@link LinuxSandbox} already applies it when its `env` option is omitted. Passing a different
 * `source` changes the VALUES, never the set of names — to give a confined command an extra variable,
 * extend the returned object, which is a fresh one on every call.
 */
export function allowlistedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = source[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Kernel-confined backend for Linux hosts: a `LocalSandbox` whose commands are rewritten as
 * `bwrap <policy flags> -- /bin/sh -c '<command>'` before they are spawned. Spawning, output caps,
 * timeouts and the `ExecuteResult` shape are all inherited, so confinement is a change to the argv
 * and never an in-process one.
 *
 * Prefer `createSandboxBackend` over constructing this directly. The class assumes bubblewrap is
 * present and never probes for it, so on a host without it every command comes back failed rather
 * than confined; the factory probes first and degrades to a plain `LocalSandbox` with a warning.
 *
 * What the confinement actually covers: the filesystem is bound read-only in full, and
 * `mode: "workspace-write"` adds the workspace root plus `/tmp` as the only writable paths, while
 * `"read-only"` adds none. The network is unshared unless `network: true`. The environment is cleared
 * and repopulated from {@link allowlistedEnv} unless an explicit `env` is passed. The seccomp syscall
 * filter is a second stage with two conditions on it — x86_64 only, and only when the network is
 * restricted — so `network: true` gives you bwrap's filesystem confinement and no syscall filter.
 * `mode: "danger-full-access"` skips the wrap entirely and this class behaves as plain
 * `LocalSandbox`.
 *
 * `uploadFile` is overridden so that writes go through the confined `execute` (base64 over stdin,
 * keeping arbitrary content out of the shell command line). A write the policy forbids therefore
 * fails, throwing a plain `Error` naming the target path and the stderr, instead of quietly landing
 * on the host as the inherited implementation would.
 */
export class LinuxSandbox extends LocalSandbox {
  private readonly mode: SandboxMode;
  private readonly network: boolean;
  private readonly cwd: string;
  private readonly bin: string;
  private readonly env: Record<string, string>;
  /** B-600 — the cBPF seccomp program, piped to `bwrap --seccomp 3` from memory (never a file a
   * confined command could replace). `undefined` when the network is unrestricted or the arch is not
   * x86_64 (honest fallback). */
  private readonly seccompProgram: Uint8Array | undefined;

  constructor(
    config: SandboxConfig,
    opts: { mode: SandboxMode; network?: boolean; bin?: string; env?: Record<string, string> },
  ) {
    super(config);
    this.mode = opts.mode;
    this.network = opts.network ?? false;
    this.cwd = config.workDir ?? process.cwd();
    // MEDIUM-1: run the VALIDATED absolute binary from detection (anti-hijack), never bare `bwrap`
    // which the outer shell would re-resolve via $PATH at spawn time (TOCTOU / hijack window).
    this.bin = opts.bin ?? "bwrap";
    this.env = opts.env ?? allowlistedEnv();
    this.seccompProgram = seccompProgramForNetwork(this.network);
  }

  /** Extracted for test visibility — delegates to the pure `wrapCommandForSandbox` (M57, single wrap SoT). */
  wrapCommand(command: string): string | null {
    return wrapCommandForSandbox(
      this.mode,
      {
        cwd: this.cwd,
        network: this.network,
        env: this.env,
        bin: this.bin,
        seccompProgram: this.seccompProgram,
      },
      command,
    );
  }

  /**
   * M75 review (architecture, HIGH) — without this override the class LIED.
   *
   * `LinuxSandbox` documents itself as a "kernel-enforced sandbox backend", but it overrode only
   * `execute`. `uploadFile` stayed the one inherited from `LocalSandbox`, which writes straight to
   * the host via `fs/promises` and accepts an ABSOLUTE path — no bwrap, no seccomp, no path
   * restriction. And `SandboxBackend.writeFile` delegates to it. The result was an incoherent class:
   * reading, searching and listing went through the confinement; writing did not.
   *
   * Routing through the wrapped `execute` fixes it at the root: writes come to live under the SAME
   * policy as everything else — if bwrap denies the path, the write fails, as it should. The content
   * goes over stdin (not argv) because argv has a size limit and file content does not.
   */
  override async uploadFile(path: string, content: string | Buffer): Promise<void> {
    if (this.mode === "danger-full-access") return super.uploadFile(path, content);

    const target = path.startsWith("/") ? path : `${this.cwd}/${path}`;
    const b64 = Buffer.from(content).toString("base64");
    // base64 on a single line: avoids any shell quoting over arbitrary content, which is exactly
    // where a "confined" write would turn into command injection.
    const r = await this.execute(
      `mkdir -p ${shellEscapePosix(dirname(target))} && printf %s ${shellEscapePosix(b64)} | base64 -d > ${shellEscapePosix(target)}`,
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `uploadFile blocked or failed under confinement (${target}): ${r.stderr.trim() || `exit ${r.exitCode}`}`,
      );
    }
  }

  override execute(command: string, opts?: { timeoutMs?: number }) {
    const wrapped = this.wrapCommand(command);
    if (wrapped === null) return super.execute(command, opts); // danger-full-access: plain local
    return super.execute(wrapped, opts);
  }
}

let warnedNonX64 = false;

/**
 * M63 — the restricted-network seccomp program is DETERMINISTIC, so write it ONCE per process and
 * reuse the path across every LinuxSandbox (no per-instance temp accumulation).
 *
 * ARCH GUARD (review HIGH): `buildSeccompFilter` emits an x86_64 program whose arch guard KILLs every
 * syscall whose `seccomp_data.arch != AUDIT_ARCH_X86_64`. On a non-x86_64 host that would brick EVERY
 * sandboxed command (the first execve is killed) — and silently, because generation succeeds and bwrap
 * accepts it. So we REFUSE to install on non-x64 and WARN through the honest-downgrade channel (bwrap
 * FS/network confinement still applies), exactly like the bwrap-missing fallback. `arch` is injectable
 * for tests. Cleaned on exit AND on SIGINT/SIGTERM (TUI Ctrl+C would otherwise leak the temp dir).
 *
 * @deprecated Writes the program to a temp file a confined command may be able to replace (B-600).
 * Use `wrapCommandForSandbox`'s `seccompProgram`, which keeps the program in memory.
 */
export function seccompPathForArch(arch: string, warn: (m: string) => void): string | undefined {
  if (arch !== "x64") {
    if (!warnedNonX64) {
      warnedNonX64 = true;
      warn(nonX64SeccompWarning(arch));
    }
    return undefined;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), "ab-seccomp-"));
    const path = join(dir, "filter.bpf");
    const program = buildSeccompFilter({ networkRestricted: true });
    writeFileSync(path, program);
    rememberSeccompFile(path, program); // the wraps pipe these bytes, never the file's (B-600)
    const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
    for (const event of ["exit", "SIGINT", "SIGTERM"] as const) process.once(event, cleanup);
    return path;
  } catch (err) {
    warn(
      `[sandbox] seccomp filter unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
        "running without syscall filter (bwrap FS/network confinement still applies).",
    );
    return undefined;
  }
}

let seccompFilterPath: string | undefined | null; // undefined = not tried; null = resolved absent
/**
 * M57 — the memoized x64-gated seccomp program, written once per process to a temp file.
 *
 * @deprecated The SDK's own wraps no longer read this file (B-600): a file under `/tmp` is one a
 * `workspace-write` command can replace. Use `wrapCommandForSandbox`'s `seccompProgram`.
 */
export function restrictedSeccompPath(): string | undefined {
  if (seccompFilterPath !== undefined) return seccompFilterPath ?? undefined;
  const path = seccompPathForArch(process.arch, (m) => console.warn(redactSecrets(m)));
  seccompFilterPath = path ?? null;
  return path;
}

let warnedUnavailable = false;

/**
 * Test seam: reset the WARN-once latch.
 *
 * Named for what it is. It was `resetSandboxWarnLatch`, plain camelCase, re-exported from the public
 * `@theokit/sdk/sandbox` barrel — indistinguishable from ordinary API, while 22 sibling test seams in
 * this package carry an unmistakable `__…ForTests` marker and stay out of their barrels.
 *
 * Deliberately NOT tagged internal-visibility: the barrel still re-exports it under the old name as a
 * deprecated alias until the next major, so the symbol has to survive `stripInternal` into the
 * emitted declarations. Tagging it removed it from the `.d.ts` and the declaration rollup failed —
 * `tsc --noEmit` never sees that.
 */
export function __resetSandboxWarnLatchForTests(): void {
  warnedUnavailable = false;
}

/** Durable sandbox posture for the UI — the honest answer to "am I kernel-enforced right now?". */
export interface SandboxPosture {
  mode: SandboxMode;
  enforced: boolean;
  detail: string;
}

/**
 * MEDIUM-2: compute the posture so a surface (TUI footer) can show enforcement DURABLY instead of a
 * one-shot warn. `danger-full-access` is honestly reported as unenforced; an unavailable bwrap reports
 * the downgrade reason so the user never believes they are confined when they are not.
 */
export function resolveSandboxPosture(opts: {
  mode: SandboxMode;
  detect?: () => BwrapDetection;
}): SandboxPosture {
  if (opts.mode === "danger-full-access") {
    return { mode: opts.mode, enforced: false, detail: "no confinement (danger-full-access)" };
  }
  const detection = (opts.detect ?? detectBwrapMemoized)();
  if (!detection.ok) {
    return { mode: opts.mode, enforced: false, detail: `tool-gating only — ${detection.reason}` };
  }
  return { mode: opts.mode, enforced: true, detail: "kernel (bwrap)" };
}

/**
 * Options for `createSandboxBackend`, which probes for bubblewrap and returns a {@link LinuxSandbox}
 * when confinement is genuinely available or a `LocalSandbox` when it is not — warning once when the
 * absence is a failure, and silently when `mode` is `"danger-full-access"`, since that is an explicit
 * opt-out rather than a degradation.
 *
 * The declared return type is `SandboxBackend` either way, so it does not tell you which one you got.
 * Call `resolveSandboxPosture({ mode })` for that, and surface it durably — the warning fires once
 * per process and a user who missed it has no way to tell they are unconfined.
 *
 * `workDir` and `timeoutMs` are forwarded into the backend's `SandboxConfig`; `maxOutputBytes` and
 * the env policy are not, and keep their defaults. `network` only reaches the confined path, being
 * meaningless on a fallback where the network was never restricted. `detect` and `warn` exist so
 * tests can drive both branches without a real bubblewrap.
 */
export interface CreateSandboxBackendOptions {
  mode: SandboxMode;
  workDir?: string;
  network?: boolean;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real 3-probe detection. */
  detect?: () => BwrapDetection;
  /** Injectable for tests; defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * Honest factory: bwrap available + mode wants confinement → `LinuxSandbox` (kernel enforcement,
 * running the VALIDATED absolute bin); `danger-full-access` → plain `LocalSandbox` silently (explicit
 * opt-out, `bwrap.rs:245-252`); bwrap unavailable → WARN once + `LocalSandbox` (the declarative M23
 * gating remains the guard). NEVER pretends to sandbox — the fallback is loud, mirroring Codex's
 * MISSING_BWRAP_WARNING. The durable posture lives in `resolveSandboxPosture` for the UI.
 */
export function createSandboxBackend(opts: CreateSandboxBackendOptions): SandboxBackend {
  const config: SandboxConfig = { workDir: opts.workDir, timeoutMs: opts.timeoutMs };
  if (opts.mode === "danger-full-access") return new LocalSandbox(config);

  const detection = (opts.detect ?? detectBwrapMemoized)();
  if (!detection.ok) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      const warn = opts.warn ?? ((m: string) => console.warn(redactSecrets(m)));
      warn(
        `[sandbox] OS-level enforcement unavailable (${detection.reason}) — ` +
          `falling back to tool-level gating only (sandbox_mode=${opts.mode}).`,
      );
    }
    return new LocalSandbox(config);
  }
  return new LinuxSandbox(config, { mode: opts.mode, network: opts.network, bin: detection.bin });
}

/**
 * M75 T3.2 — warning latch for the INTERACTIVE path.
 *
 * Kept separate from `createSandboxBackend`'s latch on purpose: they are two distinct decisions
 * taken at distinct moments, and a user who only ever runs an interactive shell needs to see the
 * warning even if the non-interactive path already emitted it — otherwise the session where they
 * actually type commands would be the one without the alert.
 */
let interactiveWarned = false;

/**
 * Reset for tests — the latch is module state and tests need isolation.
 *
 * See `__resetSandboxWarnLatchForTests` for why the name changed, and for why neither carries an
 * internal-visibility tag while the deprecated public alias exists.
 */
export function __resetInteractiveWarnLatchForTests(): void {
  interactiveWarned = false;
}

/**
 * The rule "seccomp ONLY with restricted network" — in ONE place.
 *
 * Codex installs the filter only when the network is closed (`landlock.rs:96-117`), and that is not
 * a detail: the cBPF program **denies the network syscalls** (`NETWORK_DENIED`). Applying it with
 * the network open produces the worst possible combination — bwrap **allows** the network (no
 * `--unshare-net`) and seccomp **denies** it with EPERM. The user asked for network, got the bind,
 * and the calls die.
 *
 * It existed duplicated: the constructor decided conditionally, `interactiveWrapCommand` installed
 * unconditionally. They had already diverged in the first version (M75 architecture review, proven
 * at runtime: `network:true` gave `--seccomp` interactively and not one-shot). Two copies of a
 * security rule is not duplicated form — it is duplicated KNOWLEDGE, and it had already diverged.
 */
function seccompProgramForNetwork(networkOpen: boolean): Uint8Array | undefined {
  return networkOpen ? undefined : restrictedSeccompProgram((m) => console.warn(redactSecrets(m)));
}

/**
 * Options for `interactiveWrapCommand`, the PTY counterpart of `createSandboxBackend`.
 *
 * They differ in what they hand back, and that is how you choose. A PTY owns its own spawn and
 * accepts no backend object, so this path returns a `(command, cwd) => string | null` transform: the
 * wrapped command line, or `null` meaning run it as-is. Use it when something else does the spawning;
 * use `createSandboxBackend` when you want an object that executes.
 *
 * Detection is consulted on every wrap instead of being frozen at construction, because an
 * interactive session outlives the probe — a bubblewrap binary that disappears mid-session stops
 * being asserted as present.
 *
 * `network` defaults to `false`, matching the non-interactive path, and carries the same consequence:
 * the seccomp filter is installed only when the network is restricted. The warn-once latch is
 * deliberately separate from the one `createSandboxBackend` keeps, so a user who only ever opens an
 * interactive shell still sees the "runs WITHOUT kernel confinement" warning in the session where
 * they type commands.
 */
export interface InteractiveWrapOptions {
  mode: SandboxMode;
  /** `true` keeps the network. Default `false`, same as non-interactive `run_shell`. */
  network?: boolean;
  /** Injectable for tests; defaults to the real memoized detection. */
  detect?: () => BwrapDetection;
  /** Injectable for tests; defaults to `console.warn` with redaction. */
  warn?: (message: string) => void;
}

/**
 * The decision to confine or degrade, separated from the wrap itself.
 *
 * Extracted because they are two responsibilities and the SDK's complexity gate separated them for
 * us: DECIDING (is confinement available? did the user opt out?) and APPLYING (assembling the argv).
 * Keeping them together pushed the closure past 10 cognitive complexity — and the linter was right:
 * the deciding part is the one with security consequences and deserves to be read on its own.
 *
 * Returns the validated binary when confinement exists, or `null` when it does not — warning ONCE,
 * and only when the absence is a failure (not when it is an opt-out).
 */
function decideConfinement(opts: InteractiveWrapOptions): string | null {
  if (opts.mode === "danger-full-access") return null;

  const detection = (opts.detect ?? detectBwrapMemoized)();
  if (detection.ok) return detection.bin;

  if (!interactiveWarned) {
    interactiveWarned = true;
    const warn = opts.warn ?? ((m: string) => console.warn(redactSecrets(m)));
    warn(
      `[sandbox] OS-level enforcement unavailable (${detection.reason}) — interactive session ` +
        `runs WITHOUT kernel confinement (sandbox_mode=${opts.mode}).`,
    );
  }
  return null;
}

/**
 * The composition the interactive path needs — the counterpart of `createSandboxBackend`.
 *
 * `createSandboxBackend` solves this for the non-interactive path by returning a ready BACKEND. The
 * PTY accepts no backend: it owns the spawn and only allows transforming the command. This function
 * delivers the SAME decision in the shape the PTY accepts — `(command, cwd) => string | null` —
 * ready for `new PtyInteractiveBackend({ wrapCommand: interactiveWrapCommand({ mode }) })`.
 *
 * Detection is consulted on **every wrap**, not frozen at construction: an interactive session lives
 * for hours, and a stale positive detection would keep asserting confinement after the binary
 * disappeared (the `existsSync` revalidation lives inside `detectBwrapMemoized`).
 *
 * The two routes returning `null` are semantically different and the code does not merge them:
 * `danger-full-access` is an explicit opt-out and does NOT warn; bwrap being unavailable is a
 * failure and warns once.
 */
export function interactiveWrapCommand(
  opts: InteractiveWrapOptions,
): (command: string, cwd: string) => string | null {
  return (command: string, cwd: string): string | null => {
    const bin = decideConfinement(opts);
    if (bin === null) return null;

    return wrapCommandForSandbox(
      opts.mode,
      {
        cwd,
        network: opts.network ?? false,
        env: allowlistedEnv(),
        bin,
        seccompProgram: seccompProgramForNetwork(opts.network ?? false),
      },
      command,
    );
  };
}
