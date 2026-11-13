import { type SpawnOptions, spawn } from "node:child_process";
import { ConfigurationError } from "../../../errors.js";
import { type EnvPolicy, resolveChildEnv } from "./env-policy.js";

/** Default per-stream output cap: 5 MiB (the `@theokit/sdk-tools` value). */
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/**
 * Options for {@link runBounded}: the command, where it runs, and its limits.
 *
 * @public
 */
export interface RunBoundedOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  /** Env inherit/scrub policy; defaults to `inherit-scrubbed`. `env` is merged after and wins. */
  envPolicy?: EnvPolicy;
  stdin?: string;
  /** Must be greater than 0. */
  timeoutMs: number;
  /** Per-stream cap in bytes. Default 5 MiB. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/**
 * The outcome of {@link runBounded}: the exit code, the captured output, and whether the run timed
 * out or a stream was cut at the cap.
 *
 * @public
 */
export interface RunBoundedResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True for a stream that hit `maxOutputBytes` and was cut. */
  truncated: { stdout: boolean; stderr: boolean };
  timedOut: boolean;
  spawnError?: Error;
}

interface Capture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function capture(cap: Capture, chunk: Buffer, max: number): void {
  const room = max - cap.bytes;
  if (chunk.length > room) cap.truncated = true;
  if (room <= 0) return;
  const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
  cap.chunks.push(piece);
  cap.bytes += piece.length;
}

/**
 * Runs a subprocess with a timeout, an optional abort signal and a per-stream output cap.
 *
 * On POSIX the child is spawned `detached` (its own process group) and the whole group gets
 * `SIGKILL` on timeout or abort, so pipelines and background jobs started by the command die too.
 * On Windows process groups do not apply: only `child.kill()` is used, and descendants of the
 * child may survive.
 *
 * @throws ConfigurationError when `timeoutMs` is not greater than 0.
 * @public
 */
export function runBounded(options: RunBoundedOptions): Promise<RunBoundedResult> {
  if (!(options.timeoutMs > 0)) {
    return Promise.reject(
      new ConfigurationError(`runBounded: timeoutMs must be > 0, got ${options.timeoutMs}`),
    );
  }
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const posix = process.platform !== "win32";
  return new Promise<RunBoundedResult>((resolve) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: resolveChildEnv({ policy: options.envPolicy, overrides: options.env }),
      detached: posix,
    };
    const child = spawn(options.command, [...(options.args ?? [])], spawnOptions);
    const out: Capture = { chunks: [], bytes: 0, truncated: false };
    const err: Capture = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: Buffer.concat(out.chunks).toString("utf8"),
        stderr: Buffer.concat(err.chunks).toString("utf8"),
        truncated: { stdout: out.truncated, stderr: err.truncated },
        timedOut,
        ...(spawnError === undefined ? {} : { spawnError }),
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
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      finish(null);
    }, options.timeoutMs);
    const onAbort = (): void => {
      killTree();
      finish(null);
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => capture(out, chunk, max));
    child.stderr?.on("data", (chunk: Buffer) => capture(err, chunk, max));
    child.on("error", (cause) => finish(-1, cause));
    child.on("close", (code) => finish(code));
    if (options.stdin !== undefined && child.stdin !== null) {
      // A child that exits without reading stdin closes the pipe first; the write then raises
      // EPIPE. The exit code and stderr are the result, so the error is swallowed.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}
