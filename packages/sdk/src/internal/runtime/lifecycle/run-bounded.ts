import { spawn } from "node:child_process";
import { ConfigurationError } from "../../../errors.js";
import { type EnvPolicy, resolveChildEnv } from "./env-policy.js";

/** Default per-stream output cap: 5 MiB. */
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/** Options for {@link runBounded}. */
export interface RunBoundedOptions {
  /** Executable to run. */
  command: string;
  /** Arguments passed to the executable. */
  args?: readonly string[];
  /** Working directory. */
  cwd: string;
  /** Extra env vars, merged after `envPolicy`; these always win. */
  env?: Record<string, string>;
  /** Env inherit/scrub policy. Defaults to `inherit-scrubbed`. */
  envPolicy?: EnvPolicy;
  /** Text written to the child's stdin. */
  stdin?: string;
  /** Kill the process tree after this many ms. Must be greater than zero. */
  timeoutMs: number;
  /** Per-stream output cap in bytes. Defaults to 5 MiB. */
  maxOutputBytes?: number;
  /** Aborting kills the process tree and resolves with `timedOut: false`. */
  signal?: AbortSignal;
}

/** Result of {@link runBounded}. */
export interface RunBoundedResult {
  /** Exit code; `null` when killed, `-1` on spawn error. */
  exitCode: number | null;
  /** Collected stdout, at most `maxOutputBytes` bytes. */
  stdout: string;
  /** Collected stderr, at most `maxOutputBytes` bytes. */
  stderr: string;
  /** Whether each stream was cut at the cap. */
  truncated: { stdout: boolean; stderr: boolean };
  /** True when the timeout fired. */
  timedOut: boolean;
  /** Set when the process could not be spawned. */
  spawnError?: Error;
}

/**
 * Runs a command with a timeout, an abort signal and a per-stream output cap.
 *
 * On POSIX the child leads its own process group and a timeout or abort sends
 * `SIGKILL` to the whole group, so pipelines and background jobs die with it.
 * On Windows process groups do not apply, so only the direct child is killed
 * with `child.kill()`.
 *
 * @throws ConfigurationError when `timeoutMs` is not greater than zero.
 */
export function runBounded(options: RunBoundedOptions): Promise<RunBoundedResult> {
  if (!(options.timeoutMs > 0)) {
    throw new ConfigurationError(`runBounded timeoutMs must be > 0: ${options.timeoutMs}`);
  }
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const posix = process.platform !== "win32";
  return new Promise<RunBoundedResult>((resolve) => {
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: resolveChildEnv({ policy: options.envPolicy, overrides: options.env }),
      detached: posix,
    });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;
    let settled = false;
    const text = (k: "stdout" | "stderr"): string => Buffer.concat(chunks[k]).toString("utf8");
    const settle = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: text("stdout"),
        stderr: text("stderr"),
        truncated: { ...truncated },
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
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      settle(null);
    }, options.timeoutMs);
    const onAbort = (): void => {
      killTree();
      settle(null);
    };
    const collect = (k: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = cap - sizes[k];
      if (room <= 0) {
        truncated[k] = true;
        return;
      }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated[k] = true;
      chunks[k].push(piece);
      sizes[k] += piece.length;
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    child.on("error", (cause) => settle(-1, cause));
    child.on("close", (code) => settle(code));
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.stdin !== undefined && child.stdin !== null) {
      // A child that exits without reading stdin closes the pipe first and the write raises EPIPE.
      // Swallowed: the exit code and stderr are the result; an unread payload is not a failure.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}
