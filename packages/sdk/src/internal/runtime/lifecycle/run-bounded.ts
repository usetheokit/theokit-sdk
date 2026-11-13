import { type SpawnOptions, spawn } from "node:child_process";
import { ConfigurationError } from "../../../errors.js";
import { type EnvPolicy, resolveChildEnv } from "./env-policy.js";

/** Default per-stream output cap: 5 MiB. */
export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

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
  /** Env inherit/scrub policy; defaults to `inherit-scrubbed`. `env` is merged after and wins. */
  envPolicy?: EnvPolicy;
  stdin?: string;
  /** Must be a positive finite number. */
  timeoutMs: number;
  /** Per-stream cap in bytes. Default 5 MiB. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/**
 * Outcome of {@link runBounded}.
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

interface Capture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function collect(cap: Capture, chunk: Buffer, max: number): void {
  const room = max - cap.bytes;
  if (room <= 0) {
    cap.truncated = true;
    return;
  }
  const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
  if (piece !== chunk) cap.truncated = true;
  cap.chunks.push(piece);
  cap.bytes += piece.length;
}

/** Decode, dropping a partial trailing UTF-8 sequence when the stream was cut. */
function decode(cap: Capture): string {
  let text = Buffer.concat(cap.chunks).toString("utf8");
  if (cap.truncated && text.endsWith("�")) text = text.slice(0, -1);
  return text;
}

/**
 * Run a command with a timeout, an optional abort signal and a per-stream output cap.
 *
 * On POSIX the child is spawned in its own process group and the whole group is sent SIGKILL on
 * timeout or abort, so pipelines and backgrounded jobs die with it. On Windows process groups do
 * not apply: only the direct child is killed via `child.kill()`.
 *
 * Throws {@link ConfigurationError} when `timeoutMs` is not a positive finite number.
 *
 * @public
 */
export function runBounded(options: RunBoundedOptions): Promise<RunBoundedResult> {
  const { timeoutMs } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigurationError(`runBounded timeoutMs must be a positive number: ${timeoutMs}`);
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
        stdout: decode(out),
        stderr: decode(err),
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
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      finish(null);
    }, timeoutMs);
    function onAbort(): void {
      killTree();
      finish(null);
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => collect(out, chunk, max));
    child.stderr?.on("data", (chunk: Buffer) => collect(err, chunk, max));
    child.on("error", (cause) => finish(-1, cause));
    child.on("close", (code) => finish(code));
    if (options.stdin !== undefined && child.stdin !== null) {
      // A child that exits without reading stdin closes the pipe and the write raises EPIPE on the
      // stream; unhandled that would be an uncaught exception in the SDK's own process. The exit
      // code and stderr are the result either way.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}
