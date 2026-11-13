import type { EnvPolicy } from "./env-policy.js";
import { runBounded } from "./run-bounded.js";

/**
 * Shared `child_process.spawn` wrapper that collects stdout/stderr text and
 * enforces a timeout by killing the whole process group (see `runBounded`). Used by both the hooks executor and the
 * shell tool so each spawn path doesn't reinvent the buffer + timer dance.
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
  spawnError?: Error;
}

const TRUNCATION_NOTE = "\n[output truncated]";

export async function spawnAndCollect(options: SpawnCollectOptions): Promise<SpawnCollectResult> {
  const result = await runBounded({
    command: options.command,
    ...(options.args !== undefined ? { args: options.args } : {}),
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.envPolicy !== undefined ? { envPolicy: options.envPolicy } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  return {
    stdout: result.truncated.stdout ? result.stdout + TRUNCATION_NOTE : result.stdout,
    stderr: result.truncated.stderr ? result.stderr + TRUNCATION_NOTE : result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(result.spawnError !== undefined ? { spawnError: result.spawnError } : {}),
  };
}
