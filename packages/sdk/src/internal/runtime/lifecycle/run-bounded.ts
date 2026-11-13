import { type SpawnOptions, spawn } from "node:child_process";
import { ConfigurationError } from "../../../errors.js";
import { type EnvPolicy, resolveChildEnv } from "./env-policy.js";

/** Default per-stream output cap: 5 MiB (the `@theokit/sdk-tools` value). */
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/**
 * Options for {@link runBounded}.
 *
 * @public
 */
export interface RunBoundedOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  /** Env inherit/scrub policy; defaults to `inherit-scrubbed`. `env` is merged after it and wins. */
  envPolicy?: EnvPolicy;
  stdin?: string;
  /** Must be greater than 0. */
  timeoutMs: number;
  /** Per-stream cap in bytes. Default 5 MiB. Output past the cap is dropped. */
  maxOutputBytes?: number;
  /** Aborting kills the process tree; the result has `timedOut: false`. */
  signal?: AbortSignal;
}

/**
 * Result of {@link runBounded}.
 *
 * @public
 */
export interface RunBoundedResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Whether each stream was cut at `maxOutputBytes`. */
  truncated: { stdout: boolean; stderr: boolean };
  timedOut: boolean;
  spawnError?: Error;
}

class Capped {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (chunk.length > room) {
      this.truncated = true;
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.size = this.max;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Runs a command with a deadline, a per-stream output cap and process-tree cleanup.
 *
 * On POSIX the child is spawned `detached` (its own process group) and a timeout or abort sends
 * SIGKILL to the whole group, so pipelines and background jobs die with it. On Windows process
 * groups do not apply: only the direct child is killed with `child.kill()`.
 *
 * Never rejects for a failed spawn (see `spawnError`); throws `ConfigurationError` when
 * `timeoutMs` is not greater than 0.
 *
 * @public
 */
export function runBounded(options: RunBoundedOptions): Promise<RunBoundedResult> {
  if (!(options.timeoutMs > 0)) {
    throw new ConfigurationError(
      `runBounded timeoutMs must be greater than 0: ${options.timeoutMs}`,
    );
  }
  return new Promise<RunBoundedResult>((resolve) => {
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const posix = process.platform !== "win32";
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: resolveChildEnv({ policy: options.envPolicy, overrides: options.env }),
      detached: posix,
    };
    const child = spawn(options.command, [...(options.args ?? [])], spawnOptions);
    const out = new Capped(max);
    const err = new Capped(max);
    let timedOut = false;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode,
        stdout: out.text(),
        stderr: err.text(),
        truncated: { stdout: out.truncated, stderr: err.truncated },
        timedOut,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };
    const killTree = (): void => {
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    };
    const onAbort = (): void => {
      killTree();
      settle(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      settle(null);
    }, options.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (cause) => settle(-1, cause));
    child.on("close", (code) => settle(code));
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.stdin !== undefined && child.stdin !== null) {
      // A child that exits without reading stdin closes the pipe first and the write raises EPIPE;
      // unhandled that would crash the SDK's own process. Exit code and stderr are the result.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}
