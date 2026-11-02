/**
 * Sandbox backend protocol — pluggable execution environment for agent tools.
 *
 * Per ADR D1: only 2 abstract methods (`execute` + `uploadFile`). All
 * higher-level operations are derived on the base class. New backends
 * (Docker, Firecracker, E2B) only implement those 2 methods.
 *
 * @public
 */

import { ConfigurationError, TheokitAgentError } from "../errors.js";
import type { EnvPolicy } from "../types/env-policy.js";
import { shellEscapePosix } from "./shell-escape.js";

/**
 * What a {@link SandboxBackend} returns for one command.
 *
 * `exitCode` is a coarse signal rather than the child's real exit status: the backends in this
 * package report `0` on success, `124` on timeout, and `1` for everything else — including a command
 * that exited with its own non-zero code. Read `timedOut` to tell a killed command from a failed one,
 * and `stderr` for the reason; branching on a specific exit code will not work here.
 *
 * `stdout` and `stderr` are truncated independently at `SandboxConfig.maxOutputBytes`, with a
 * trailing `...(truncated)` marker. Neither is safe to parse as a complete document without checking
 * for it.
 */
export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Construction-time settings shared by every {@link SandboxBackend}. All fields are optional and the
 * base constructor fills them in, so `{}` is a valid config: `workDir` `/tmp`, `timeoutMs` 30000,
 * `maxOutputBytes` 5 MiB, `env` `"inherit-scrubbed"`.
 *
 * `workDir` is the child process's cwd and the base a relative `uploadFile` path resolves against. It
 * is not a boundary — under `LocalSandbox` nothing stops a command, or an absolute path, from leaving
 * it. Only `LinuxSandbox` makes it enforceable.
 *
 * `timeoutMs` is the default for every call; `execute(command, { timeoutMs })` overrides it per
 * command. On expiry the child is killed and the result carries `timedOut: true` with `exitCode`
 * 124 — the partial output collected so far is still returned.
 */
export interface SandboxConfig {
  workDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * #54 — env inherit/scrub policy for the executed command's child process.
   * Defaults to `"inherit-scrubbed"` (drop secret-like vars: `*KEY*`, `*SECRET*`,
   * `*TOKEN*`, `*PASSWORD*`, `*_AUTH*`). Pass `"all"` to restore full inheritance
   * or `"core"` for a minimal safe allowlist.
   */
  env?: EnvPolicy;
}

/**
 * A backend refused a command on policy grounds — the environment works, and it said no. Carries a
 * stable `code: "sandbox_security"` for callers that prefer not to match on the class.
 *
 * Nothing in this package throws it, which is worth knowing before you write a `catch` for it:
 * `LocalSandbox` and `LinuxSandbox` report a refusal through {@link ExecuteResult} (non-zero
 * `exitCode`, reason on `stderr`), and a write blocked under confinement surfaces as a plain `Error`
 * from `uploadFile`. This type exists so a custom backend that must reject a command BEFORE spawning
 * anything — a container or VM runner enforcing its own policy — can do so in the protocol's
 * vocabulary instead of inventing an error of its own.
 */
export class SandboxSecurityError extends TheokitAgentError {
  override readonly name = "SandboxSecurityError";
  override readonly code = "sandbox_security" as const;
  constructor(message: string) {
    // not retryable: a refused command is refused every time; retrying re-asks the same question
    super(message, { code: "sandbox_security", isRetryable: false });
  }
}

/**
 * A backend cannot be used at all: its runtime is missing or unusable. The distinction from
 * {@link SandboxSecurityError} is which side failed — there the sandbox worked and denied the
 * command, here there is no sandbox. Carries `code: "sandbox_not_available"`.
 *
 * Nothing in this package throws it either, and that is a position rather than an oversight:
 * `createSandboxBackend` treats a missing bubblewrap as a degradation, warns once, and hands back an
 * unconfined `LocalSandbox`. Throw this instead from a backend that must never silently run outside
 * its isolation.
 */
export class SandboxNotAvailableError extends TheokitAgentError {
  override readonly name = "SandboxNotAvailableError";
  override readonly code = "sandbox_not_available" as const;
  constructor(message: string) {
    // not retryable: a missing runtime does not appear on a second attempt
    super(message, { code: "sandbox_not_available", isRetryable: false });
  }
}

/**
 * The execution capability handed to an agent tool, and the extension point for new environments.
 *
 * A backend implements exactly two methods, `execute` and `uploadFile`. Everything else here —
 * `readFile`, `glob`, `grep`, `listDir` — is derived from `execute` by shelling out `cat`, `find`,
 * `grep` and `ls`, so a subclass that overrides `execute` alone inherits confined reads, searches and
 * listings for free. It does not inherit confined writes: `writeFile` delegates to `uploadFile`, and
 * that is the second override `LinuxSandbox` needs.
 *
 * Choosing one: `LocalSandbox` runs the command on the host with no isolation and suits code you
 * already trust; `LinuxSandbox` adds kernel confinement where bubblewrap is available;
 * `createSandboxBackend` probes and picks between them, and is the right entry point unless you have
 * a reason to pin one. For genuinely untrusted code you want a container or VM backend, which this
 * package does not ship — write it against these two methods.
 *
 * Because the derived helpers assemble shell command lines (arguments escaped for POSIX `sh`), a
 * backend whose `execute` is not a POSIX shell must override them as well.
 */
export abstract class SandboxBackend {
  protected config: SandboxConfig;

  constructor(config: SandboxConfig = {}) {
    this.config = {
      workDir: config.workDir ?? "/tmp",
      timeoutMs: config.timeoutMs ?? 30_000,
      maxOutputBytes: config.maxOutputBytes ?? 5 * 1024 * 1024,
      // #54 — preserve the env policy so backends can scrub secrets.
      env: config.env ?? "inherit-scrubbed",
    };
  }

  abstract execute(command: string, opts?: { timeoutMs?: number }): Promise<ExecuteResult>;

  abstract uploadFile(path: string, content: string | Buffer): Promise<void>;

  async readFile(path: string): Promise<string> {
    const result = await this.execute(`cat ${this.shellEscape(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`readFile failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.uploadFile(path, content);
  }

  async glob(pattern: string, cwd?: string): Promise<string[]> {
    const dir = cwd ?? this.config.workDir ?? ".";
    const result = await this.execute(
      `find ${this.shellEscape(dir)} -name ${this.shellEscape(pattern)} -type f 2>/dev/null`,
    );
    this.assertCommandRan("glob", result);
    return result.stdout.trim().split("\n").filter(Boolean);
  }

  async grep(pattern: string, path?: string): Promise<string[]> {
    const target = path ?? ".";
    const result = await this.execute(
      `grep -rn ${this.shellEscape(pattern)} ${this.shellEscape(target)} 2>/dev/null`,
    );
    // `grep` exits 1 for NO MATCH and >= 2 for an error, so a 1 is an answer and is not asserted on.
    if (result.exitCode !== 1) this.assertCommandRan("grep", result);
    return result.stdout.trim().split("\n").filter(Boolean);
  }

  async listDir(path: string): Promise<string[]> {
    const result = await this.execute(`ls -1 ${this.shellEscape(path)}`);
    this.assertCommandRan("listDir", result);
    return result.stdout.trim().split("\n").filter(Boolean);
  }

  /**
   * Turns "the command did not run" into an error instead of an empty array.
   *
   * `glob`, `grep` and `listDir` used to `return []` on any non-zero exit, so a search that could not
   * run reported the same thing as a search that found nothing — opposite facts, one normal and one
   * meaning the agent is looking at a filesystem it cannot read. That is the failure mode a backend
   * whose `execute` is not a POSIX shell hits, which this class's own docblock warns about in prose
   * and could not enforce.
   *
   * A genuine no-match is still `[]`: `find` exits 0 with empty output, and `grep`'s exit 1 is
   * checked by its caller before this is reached.
   */
  private assertCommandRan(operation: string, result: ExecuteResult): void {
    if (result.exitCode === 0) return;
    throw new ConfigurationError(
      `${operation} failed (exit ${String(result.exitCode)}): ${result.stderr.trim() || "no stderr"}. ` +
        `The derived helpers shell out to POSIX \`cat\`/\`find\`/\`grep\`/\`ls\` — a backend whose ` +
        `execute() is not a POSIX shell must override them.`,
      { code: "sandbox_derived_helper_failed" },
    );
  }

  protected truncateOutput(output: string): string {
    const max = this.config.maxOutputBytes ?? 5 * 1024 * 1024;
    if (Buffer.byteLength(output) > max) {
      return `${output.slice(0, max)}\n...(truncated)`;
    }
    return output;
  }

  private shellEscape(arg: string): string {
    return shellEscapePosix(arg);
  }
}

/**
 * A backend OR a per-request resolver of one — mirrors `FilesystemProvider` / `InteractiveProvider`.
 * A resolver runs at tool-execution time (request scope), so a multi-tenant / multi-role agent gets a
 * distinct sandbox per request without a shared mutable one. This is how a tool takes execution as an
 * INJECTED capability: the same tool runs on a local sandbox, a container/E2B backend (cluster/web), or
 * any future backend, with no direct `child_process` import.
 *
 * @public
 */
export type SandboxProvider<Ctx = unknown> =
  | SandboxBackend
  | ((ctx: Ctx) => SandboxBackend | Promise<SandboxBackend>);

/** Resolve a {@link SandboxProvider} to a concrete backend for `ctx`. */
export async function resolveSandbox<Ctx>(
  provider: SandboxProvider<Ctx>,
  ctx: Ctx,
): Promise<SandboxBackend> {
  return provider instanceof SandboxBackend ? provider : provider(ctx);
}

/** Codex's three canonical sandbox modes; lives in this leaf module so bwrap.ts and deny-read.ts need not import each other. */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Result of probing for bubblewrap. Detection never throws. */
export type BwrapDetection = { ok: true; bin: string } | { ok: false; reason: string };
