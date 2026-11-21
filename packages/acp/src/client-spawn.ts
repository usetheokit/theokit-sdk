/**
 * Command resolution and child-process handling for `connectAcpAgent`.
 *
 * Nothing is inherited implicitly: the child gets exactly the `env` the caller passed, and the
 * command is looked up on that same `env.PATH`, never on this process's own.
 *
 * @internal
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { TheokitAgentError } from "@theokit/sdk";

const STDERR_MAX_LINES = 20;
const STDERR_MAX_CHARS = 4096;
const KILL_GRACE_MS = 2000;

/**
 * Thrown when the agent process cannot be started, is refused before starting, or exits before it
 * finished initializing or while a prompt was running.
 *
 * @public
 */
export class AcpAgentSpawnError extends TheokitAgentError {
  override readonly name: string = "AcpAgentSpawnError";
  /** Exit code of the child, when it exited; `null` when it was killed by a signal. */
  readonly exitCode?: number | null;
  /** The last (bounded) lines the child wrote to stderr. */
  readonly stderrTail?: string;

  constructor(
    message: string,
    options: { cause?: unknown; exitCode?: number | null; stderrTail?: string } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
    if (options.stderrTail !== undefined) this.stderrTail = options.stderrTail;
  }
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `command` to an absolute executable path, or throw {@link AcpAgentSpawnError}.
 *
 * An absolute command is used as is. A bare name is searched on `env.PATH` in order; a relative or
 * empty PATH entry reached before a match refuses the lookup (it would resolve against the working
 * directory). A command with a path separator that is not absolute is refused.
 */
export function resolveCommand(command: string, env: Record<string, string>): string {
  if (command.length === 0) throw new AcpAgentSpawnError("ACP agent command is empty");
  if (path.isAbsolute(command)) {
    if (!isExecutable(command)) {
      throw new AcpAgentSpawnError(`ACP agent command not found or not executable: ${command}`);
    }
    return command;
  }
  if (command.includes("/") || command.includes(path.sep)) {
    throw new AcpAgentSpawnError(`ACP agent command must be absolute or a bare name: ${command}`);
  }
  return searchPath(command, env.PATH ?? "");
}

function searchPath(command: string, pathValue: string): string {
  for (const entry of pathValue.split(path.delimiter)) {
    if (entry === "" || !path.isAbsolute(entry)) {
      throw new AcpAgentSpawnError(
        `refusing to resolve "${command}": PATH has a relative or empty entry (${JSON.stringify(entry)})`,
      );
    }
    const candidate = path.join(entry, command);
    if (isExecutable(candidate)) return candidate;
  }
  throw new AcpAgentSpawnError(`ACP agent command not found on PATH: ${command}`);
}

/** A spawned agent process with bounded stderr capture. @internal */
export interface AgentChild {
  readonly process: ChildProcessWithoutNullStreams;
  /** Resolves once the process has exited and its stdio is closed. */
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrTail(): string;
  hasExited(): boolean;
  /** Terminate the process (its group on POSIX) and wait for it to close. */
  kill(): Promise<void>;
}

export function spawnAgent(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<AgentChild> {
  const posix = process.platform !== "win32";
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: posix,
  });
  let tail = "";
  let exited = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_MAX_CHARS * 2);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const handle: AgentChild = {
    process: child,
    closed,
    hasExited: () => exited,
    stderrTail: () =>
      tail.split("\n").filter(Boolean).slice(-STDERR_MAX_LINES).join("\n").slice(-STDERR_MAX_CHARS),
    async kill() {
      const signalGroup = (sig: NodeJS.Signals): void => {
        try {
          if (posix && child.pid !== undefined) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          // already gone
        }
      };
      if (!exited) {
        child.stdin.destroy();
        signalGroup("SIGTERM");
        const timer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
        await closed;
        clearTimeout(timer);
      }
      // Reap stragglers left in the group after the leader exited.
      signalGroup("SIGKILL");
    },
  };
  return new Promise((resolve, reject) => {
    child.once("error", (err) =>
      reject(new AcpAgentSpawnError(`failed to spawn ACP agent: ${err.message}`, { cause: err })),
    );
    child.once("spawn", () => resolve(handle));
  });
}
