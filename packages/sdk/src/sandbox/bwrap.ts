// Promoted out of the agent-builder in M75 (plan m75-sandbox-kernel-no-framework, D1): kernel
// confinement is framework infrastructure, not the consumer's. Measured cost of the promotion: ZERO
// dependencies — only node:child_process, node:fs and node:path. The cBPF filter is a pure-JS Buffer.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { denyReadFlags } from "./deny-read.js";

/*
 * M53 — bubblewrap argv + honest detection.
 *
 * HONEST SCOPE: filesystem confinement + network isolation via bwrap, PLUS the second stage —
 * a cBPF seccomp syscall filter (`agents/sandbox/seccomp.ts`), wired in `agents/sandbox/backend.ts`
 * via `restrictedSeccompPath()`. Ported in M63; this block claimed the opposite until M67 and
 * UNDER-DECLARED the real security posture. The honest limit that remains: the filter is **x86_64**
 * (an architecture guard refuses to install it on any other arch, with a WARN, and bwrap's FS/network
 * confinement still applies) **and** it is only installed when the network is restricted
 * (`backend.ts:87`, faithful to `landlock.rs:96-117`): with the network on there is no syscall
 * filter, only bwrap's FS confinement. `danger-full-access` skips bwrap entirely, mirroring
 * `bwrap.rs:245-252`. Deltas versus Codex remain documented in docs/CODEX-PARITY.md.
 */

/**
 * Codex's three canonical modes. Defined HERE because they are sandbox vocabulary, not consumer
 * configuration: `danger-full-access` means "do not wrap", and that is a decision belonging to the
 * confinement subsystem.
 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * The RW binds `workspace-write` installs (protocol.rs:1189-1214), plus the metadata protection that
 * must sit ON TOP of them — order matters (permissions.rs:22-31; bwrap.rs:571-597).
 */
function pushWorkspaceBinds(argv: string[], cwd: string, hasGit: boolean, gitDir: string): void {
  for (const root of workspaceWriteRoots(cwd)) argv.push("--bind", root, root);
  if (hasGit) argv.push("--ro-bind", gitDir, gitDir);
}

/** The RW binds `workspace-write` installs (protocol.rs:1189-1214): the workspace itself, and /tmp. */
function workspaceWriteRoots(cwd: string): readonly string[] {
  return [cwd, "/tmp"];
}

/**
 * U-6 — the roots a mode may write to, answerable WITHOUT spawning anything.
 *
 * `[]` means nothing is writable; `null` means unrestricted — which is not the same as `["/"]`,
 * because unrestricted is the absence of a root rather than a root that happens to be `/`.
 *
 * The SDK already knew this: `buildBwrapArgv` binds these exact paths. It only knew it while
 * BUILDING an argv, and a consumer needs the answer earlier — tools are scoped at agent
 * construction, before any process exists, and a file-write tool has to be told its root then. With
 * nothing to ask, consumers keep a second encoding of this three-mode vocabulary and it drifts from
 * the argv builder with nothing to catch it. This reads from the same helper the builder uses, so
 * the two cannot disagree.
 */
export function writableRootsFor(mode: SandboxMode, cwd: string): readonly string[] | null {
  switch (mode) {
    case "read-only":
      return [];
    case "workspace-write":
      return workspaceWriteRoots(cwd);
    case "danger-full-access":
      return null;
  }
}

/**
 * Everything {@link buildBwrapArgv} needs besides the {@link SandboxMode}.
 *
 * Only `cwd` is required, and it is resolved to an absolute path before any bind
 * is emitted. The defaults are the restrictive ones in one direction and the
 * permissive one in the other: omitting `network` emits `--unshare-net` (no
 * network), while omitting `env` means the child INHERITS the parent
 * environment — bwrap only clears it when an allowlist is supplied.
 */
export interface BwrapArgvOptions {
  /** Workspace root — the single RW bind under `workspace-write` (protocol.rs:1189-1200). */
  cwd: string;
  /** `true` removes `--unshare-net` (policy `network_access`, default false). */
  network?: boolean;
  /** Injectable for tests; defaults to a real `existsSync` check on `<cwd>/.git`. */
  gitDirExists?: boolean;
  /**
   * When present, emit `--clearenv` and re-inject ONLY these vars (Codex env_clear model,
   * `exec_env.rs:25-31`). Closes the denylist gap: a secret in an oddly-named var never reaches the
   * sandboxed child. Omitted ⇒ inherit the parent env (backward-compatible; SDK scrub still applies).
   */
  env?: Record<string, string>;
  /**
   * Absolute paths the confined command must not read. Each is resolved through symlinks and masked
   * after the writable binds: a directory becomes empty, a file reads as permission denied. A masked
   * file still shows in the listing of its directory. Throws `TypeError` for a relative or missing
   * path, one that contains the workspace, `/tmp` or `/`, and any list under `danger-full-access`.
   */
  denyReadPaths?: readonly string[];
}

/**
 * Pure argv builder. Returns the bwrap flags ending in `--` (caller appends `/bin/sh -c <cmd>`),
 * or `null` when the policy skips the sandbox entirely (`danger-full-access`).
 */
export function buildBwrapArgv(mode: SandboxMode, opts: BwrapArgvOptions): string[] | null {
  const cwd = path.resolve(opts.cwd);
  const denyFlags = denyReadFlags(opts.denyReadPaths, { mode, cwd }); // throws before the null below
  if (mode === "danger-full-access") return null; // bwrap skipped entirely (bwrap.rs:245-252)

  const gitDir = path.join(cwd, ".git");
  const hasGit = opts.gitDirExists ?? existsSync(gitDir);

  const argv: string[] = [
    // core, always (bwrap.rs:318-332; user+pid namespaces explicit so it works as root in containers)
    "--new-session",
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    // full-read filesystem base (bwrap.rs:446-452)
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];

  if (!opts.network) argv.push("--unshare-net"); // network off by default (bwrap.rs:325-327)

  // env confinement — `--clearenv` MUST precede every `--setenv` or the clear wipes them
  // (exec_env.rs:25-31 clears then rebuilds). Only when an explicit allowlist is provided.
  if (opts.env) argv.push("--clearenv");
  const setenv: Record<string, string> = {
    ...(opts.env ?? {}),
    // the flag signals the child that network is unshared (spawn.rs:20,79)
    ...(opts.network ? {} : { CODEX_SANDBOX_NETWORK_DISABLED: "1" }),
  };
  for (const [k, v] of Object.entries(setenv)) argv.push("--setenv", k, v);

  if (mode === "workspace-write") pushWorkspaceBinds(argv, cwd, hasGit, gitDir);
  // read-only: zero writable roots (protocol.rs:1176) — nothing to add
  argv.push(...denyFlags); // after the writable binds so a mask inside the workspace or /tmp wins

  argv.push("--chdir", cwd, "--");
  return argv;
}

/** Injectable probes — each mirrors one Codex availability check. */
export interface BwrapProbes {
  /** `which bwrap` outside the cwd (anti-hijack, sandboxing/src/bwrap.rs:168-191). */
  which: () => string | null;
  /** `bwrap --help` text — must advertise `--perms` (launcher.rs:108-124). */
  helpText: (bin: string) => string | null;
  /** Active user-namespace probe with timeout (sandboxing/src/bwrap.rs:74-136). */
  userns: (bin: string) => boolean;
}

/**
 * Result of {@link detectBwrap} / {@link detectBwrapMemoized}, discriminated on
 * `ok`: `{ ok: true, bin }` carries the absolute path of the validated `bwrap`,
 * `{ ok: false, reason }` a human-readable cause — "bwrap not found in PATH",
 * "bwrap at <bin> lacks --perms support (too old)",
 * "user namespaces unavailable (container/kernel restriction)",
 * "bwrap probe failed: <err>", or (memoized only)
 * "bwrap disappeared from <bin> after detection".
 *
 * `reason` is prose for a warning line. It is not a stable code — do not branch
 * on it.
 *
 * `ok: false` is an ordinary outcome rather than an error: bubblewrap is
 * Linux-only, so failing detection on macOS, on Windows, or inside a container
 * without user namespaces is expected. Detection NEVER throws, so wrapping it in
 * `try`/`catch` catches nothing; callers warn and fall back to an unconfined
 * `LocalSandbox`.
 */
export type BwrapDetection = { ok: true; bin: string } | { ok: false; reason: string };

/** Honest detection — fail-closed on every probe; NEVER throws (callers WARN + fall back). */
export function detectBwrap(probes: BwrapProbes = realProbes): BwrapDetection {
  try {
    const bin = probes.which();
    if (!bin) return { ok: false, reason: "bwrap not found in PATH" };
    const help = probes.helpText(bin);
    if (!help?.includes("--perms")) {
      return { ok: false, reason: `bwrap at ${bin} lacks --perms support (too old)` };
    }
    if (!probes.userns(bin)) {
      return { ok: false, reason: "user namespaces unavailable (container/kernel restriction)" };
    }
    return { ok: true, bin };
  } catch (err) {
    return {
      ok: false,
      reason: `bwrap probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * How many times the REAL probe ran in this process.
 *
 * Instrumented here rather than in a wrapper, because this is where the cost is: every `which`
 * spawns a subprocess (`which bwrap`), and the full probe cost 22.2 ms. A gate counting INJECTED
 * probes does not see the real one — that was the M71 gate's first mistake, and a mutant exposed it.
 */
let realProbeRuns = 0;

/** How many real probes ran. TEST seam — the performance gate counts this. */
export function realProbeCount(): number {
  return realProbeRuns;
}

/** Real probes used in production. */
export const realProbes: BwrapProbes = {
  which: () => {
    realProbeRuns++;
    try {
      const out = execFileSync("which", ["bwrap"], { encoding: "utf8", timeout: 2_000 }).trim();
      // anti-hijack: never accept a bwrap that lives inside the workspace (bwrap.rs:168-191)
      if (!out || out.startsWith(process.cwd() + path.sep)) return null;
      return out;
    } catch {
      return null;
    }
  },
  helpText: (bin) => {
    try {
      // bwrap --help exits 0/1 depending on version; capture output either way
      return execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 2_000 });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return [e.stdout, e.stderr].filter(Boolean).join("\n") || null;
    }
  },
  userns: (bin) => {
    try {
      // active probe, 500ms budget like Codex (sandboxing/src/bwrap.rs:74-136)
      execFileSync(bin, ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "/bin/true"], {
        timeout: 500,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The probe result, memoized for the lifetime of the PROCESS.
 *
 * Measured before M71: `detectBwrap()` costs **22.2 ms** and was not memoized — the second call
 * cost 19.4 ms. `buildChatAgent` on the headless path fired **two** (one from
 * `createSandboxBackend`, another from `resolveSandboxPosture`, which M70 added), totalling 46.4 ms
 * per construction — and construction happens per turn. Under `strace`, ~90% of the 182 syscalls of
 * an already-warm construction came from here: `which` sweeping the PATH, `/proc/filesystems`,
 * `/newroot`, and the `.so` files the two probe subprocesses load.
 *
 * ## Why there is no invalidation
 *
 * The milestone called for invalidating on `SessionStart`. That does not work:
 * `agents/lib/hooks/hooks.ts:28-30` documents — as a **measured** correction of an earlier
 * assumption — that the event fires **once per TURN**, not per session. Invalidating there would
 * re-probe every turn, exactly the behavior memoization exists to eliminate.
 *
 * A write-once cache is sufficient here: the expensive probe runs once per process,
 * only to print a UI warning.
 *
 * **The price, stated plainly — in BOTH directions.** The original m71-cost-per-turn#ADR-1 declared
 * only one of them; the M71 review (F-perf-9) showed the omitted one was precisely the one with a
 * security consequence:
 *
 * - **Stale negative** (`bwrap` installed AFTERWARDS): not detected until restart. The system fails
 *   CLOSED — the posture reports `enforced: false` and M70's veto **refuses**. Cost: annoyance (the
 *   message tells you to install the bwrap you just installed). Accepted.
 * - **Stale positive** (`bwrap` removed/renamed AFTERWARDS): the posture would keep asserting
 *   `enforced: true / "kernel (bwrap)"` and the veto would **approve**, citing a confinement that no
 *   longer exists. That is the literal reintroduction of the defect M70 fixed — *"telling the
 *   operator they are protected when they are not is worse than saying nothing"*. Before M71 the
 *   per-turn re-probe closed that window on the next turn; memoization would leave it open for the
 *   whole process. **That is why the positive is revalidated** below, at 1 syscall — 3 orders of
 *   magnitude below the 22.2 ms of the full probe, which is the cost memoization exists to remove.
 */
let memo: BwrapDetection | undefined;

/**
 * `detectBwrap` with memoization — what production should call.
 *
 * Note that `detectBwrap` itself does **not** memoize, on purpose: it accepts injected probes, and
 * memoizing there would let a test with fake probes poison the process cache for everyone else.
 *
 * Revalidating the positive is NOT a re-probe: `detectBwrap` spends three probes (a `which`
 * subprocess + `--help` + a user namespace). Here we only confirm the validated binary is still in
 * place. If it vanished, the memo is downgraded to a negative with the reason stated — never
 * promoted to a positive, which would require the expensive probe back.
 */
export function detectBwrapMemoized(probes: BwrapProbes = realProbes): BwrapDetection {
  memo ??= detectBwrap(probes);
  if (memo.ok && !existsSync(memo.bin)) {
    memo = { ok: false, reason: `bwrap disappeared from ${memo.bin} after detection` };
  }
  return memo;
}

/**
 * Clears the `detectBwrapMemoized` memo.
 *
 * Kept PUBLIC, unlike the two warn-latch resets that moved to the `__…ForTests` convention, because
 * this one has a use outside a test that the others do not: a long-lived host that probed before
 * `bwrap` was installed is memoized on the wrong answer forever, and this is the only way to make it
 * re-probe. It is the companion to `detectBwrapMemoized` and is documented as such rather than as a
 * seam. Production inside this package never calls it (see m71-cost-per-turn#ADR-1).
 *
 * @public
 */
export function resetBwrapMemo(): void {
  memo = undefined;
}
