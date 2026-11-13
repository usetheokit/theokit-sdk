import type { EnvPolicy } from "./env-policy.js";
import { type RunBoundedResult, runBounded } from "./run-bounded.js";

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

export type SpawnCollectResult = RunBoundedResult;

export function spawnAndCollect(options: SpawnCollectOptions): Promise<SpawnCollectResult> {
  // `runBounded` rejects a non-positive timeout; this wrapper historically treated it as "expire
  // immediately", so clamp to keep that.
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
  return runBounded({
    command: options.command,
    ...(options.args !== undefined ? { args: options.args } : {}),
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.envPolicy !== undefined ? { envPolicy: options.envPolicy } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs,
  });
}
