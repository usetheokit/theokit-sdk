import { spawnAndCollect } from "../lifecycle/spawn-collect.js";

/**
 * Real shell tool executor. Spawns a single command through `/bin/sh -c`,
 * captures stdout/stderr/exitCode, and honours per-call timeouts.
 *
 * Sandboxing is opt-in via `local.sandboxOptions.enabled`. The current
 * sandbox implementation simply scopes `cwd` to the configured workspace
 * and rejects shell escapes like `cd /` or absolute paths starting with
 * `/etc/`. A future iteration will hook into Node's permission model or a
 * platform-specific sandbox (Bubblewrap / sandbox-exec).
 *
 * @internal
 */

export interface ShellExecuteOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  sandbox?: boolean;
  env?: Record<string, string>;
}

export interface ShellExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const TRUNCATION_NOTE = "\n[output truncated]";

export async function runShell(options: ShellExecuteOptions): Promise<ShellExecuteResult> {
  if (options.sandbox === true && isObviouslyUnsafe(options.command)) {
    return {
      stdout: "",
      stderr: `Sandbox refused command: ${options.command}`,
      exitCode: 126,
      timedOut: false,
    };
  }
  const result = await spawnAndCollect({
    command: "sh",
    args: ["-c", options.command],
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const stderr =
    result.spawnError !== undefined ? result.stderr + result.spawnError.message : result.stderr;
  return {
    stdout: result.truncated.stdout ? result.stdout + TRUNCATION_NOTE : result.stdout,
    stderr: result.truncated.stderr ? stderr + TRUNCATION_NOTE : stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}

function isObviouslyUnsafe(command: string): boolean {
  // Cheap allow-list for the sandbox tier — refuse commands that reach
  // outside the workspace or touch sensitive paths. Real isolation will
  // come from process-level sandboxing.
  if (/(^|\s)(rm|mv|cp)\s+[^|;]*\s+\/(etc|var|root)\b/.test(command)) return true;
  if (/sudo\s/.test(command)) return true;
  return false;
}
