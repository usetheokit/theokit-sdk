import type { EnvPolicy } from "./env-policy.js";
import { runBounded } from "./run-bounded.js";

/**
 * Thin wrapper over {@link runBounded}: collects stdout/stderr text and enforces a timeout that
 * kills the whole process group. Used by both the hooks executor and the shell tool.
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

export async function spawnAndCollect(options: SpawnCollectOptions): Promise<SpawnCollectResult> {
  const r = await runBounded({
    command: options.command,
    ...(options.args !== undefined ? { args: options.args } : {}),
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.envPolicy !== undefined ? { envPolicy: options.envPolicy } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const note = "\n[output truncated]";
  return {
    stdout: r.truncated.stdout ? r.stdout + note : r.stdout,
    stderr: r.truncated.stderr ? r.stderr + note : r.stderr,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    ...(r.spawnError !== undefined ? { spawnError: r.spawnError } : {}),
  };
}
