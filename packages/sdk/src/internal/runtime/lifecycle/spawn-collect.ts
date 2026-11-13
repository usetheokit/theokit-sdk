import type { EnvPolicy } from "./env-policy.js";
import { runBounded } from "./run-bounded.js";

/**
 * Thin wrapper over {@link runBounded}, used by both the hooks executor and the shell tool.
 * Timeout kills the whole process group (POSIX) and output is capped per stream.
 *
 * @internal
 */

export interface SpawnCollectOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * #54 — env inherit/scrub policy for the child. Defaults to
   * `inherit-scrubbed` (drop secret-like vars). `env` above is merged AFTER the
   * policy and always wins. Pass `"all"` to restore full inheritance.
   */
  envPolicy?: EnvPolicy;
  timeoutMs?: number;
  stdin?: string;
}

export interface SpawnCollectResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: { stdout: boolean; stderr: boolean };
  spawnError?: Error;
}

export function spawnAndCollect(options: SpawnCollectOptions): Promise<SpawnCollectResult> {
  return runBounded({
    command: options.command,
    ...(options.args !== undefined ? { args: options.args } : {}),
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.envPolicy !== undefined ? { envPolicy: options.envPolicy } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    // runBounded rejects a non-positive timeout; keep the old tolerance here.
    timeoutMs: Math.max(1, options.timeoutMs ?? 30_000),
  });
}
