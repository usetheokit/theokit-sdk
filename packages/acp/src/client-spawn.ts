/**
 * Child-process handling for `connectAcpAgent`: command resolution, spawning, bounded stderr
 * capture, and process-group termination.
 *
 * @internal
 */

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { TheokitAgentError } from "@theokit/sdk";

const MAX_STDERR_LINES = 20;
const MAX_STDERR_CHARS = 4096;
const KILL_GRACE_MS = 2000;

/** The agent child could not be started, was refused before starting, or exited when it should not have. */
export class AcpAgentSpawnError extends TheokitAgentError {
  override readonly name: string = "AcpAgentSpawnError";
  /** Exit code of the child, when it exited with one. */
  readonly exitCode?: number | null;
  /** Signal that ended the child, when it was killed by one. */
  readonly signal?: string | null;

  constructor(
    message: string,
    options: { exitCode?: number | null; signal?: string | null; cause?: unknown } = {},
  ) {
    super(message, {
      code: "acp_agent_spawn_failed",
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
    if (options.signal !== undefined) this.signal = options.signal;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(dir: string, command: string): string[] {
  if (process.platform !== "win32") return [join(dir, command)];
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";");
  return [join(dir, command), ...exts.map((ext) => join(dir, command + ext))];
}

/**
 * Resolve `command` to an absolute path. An absolute command is used as is. A bare name is looked
 * up on `env.PATH` only (never `process.env`), and is refused outright when any PATH entry is empty
 * or relative: such an entry resolves against the working directory (#1800).
 */
export function resolveCommand(command: string, env: Record<string, string>): string {
  if (command.length === 0) throw new AcpAgentSpawnError("acp agent command is empty");
  if (isAbsolute(command)) return command;
  if (/[\\/]/.test(command)) {
    throw new AcpAgentSpawnError(
      `refusing relative acp agent command "${command}": use an absolute path`,
    );
  }
  const entries = (env.PATH ?? "").split(delimiter);
  if (entries.some((entry) => entry === "" || !isAbsolute(entry))) {
    throw new AcpAgentSpawnError(
      `refusing to resolve "${command}": PATH has an empty or relative entry`,
    );
  }
  for (const dir of entries) {
    const found = candidates(dir, command).find(isExecutableFile);
    if (found !== undefined) return found;
  }
  throw new AcpAgentSpawnError(`acp agent command "${command}" not found on PATH`);
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
  spawnError?: Error;
}

export interface AgentChild {
  process: ChildProcess;
  /** Settles when the child has closed (or failed to start) and its stderr is drained. */
  exited: Promise<ChildExit>;
  /** The last stderr lines, bounded. */
  stderrTail(): string;
  /** SIGTERM the process group (the child on Windows), SIGKILL after a grace, and wait for it to close. */
  kill(): Promise<void>;
}

export interface SpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

function trackStderr(child: ChildProcess): () => string {
  let lines: string[] = [];
  let partial = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop() ?? "";
    lines = [...lines, ...parts].slice(-MAX_STDERR_LINES);
  });
  return () => {
    const all = partial.length > 0 ? [...lines, partial] : lines;
    return all.slice(-MAX_STDERR_LINES).join("\n").slice(-MAX_STDERR_CHARS);
  };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

/** Spawn the agent with exactly `options.env`; the caller has already resolved `command`. */
export function spawnAgentChild(resolved: string, options: SpawnOptions): AgentChild {
  const child = spawn(resolved, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdin?.on("error", () => undefined);
  const stderrTail = trackStderr(child);
  let closed = false;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once("error", (spawnError) => {
      closed = true;
      resolve({ code: null, signal: null, spawnError });
    });
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  const kill = async (): Promise<void> => {
    if (closed) return;
    signalGroup(child, "SIGTERM");
    const timer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
    await exited;
    clearTimeout(timer);
    // The leader may have exited while descendants in its group survive SIGTERM.
    signalGroup(child, "SIGKILL");
  };
  return { process: child, exited, stderrTail, kill };
}

/** Build the error for a child that exited when it was not supposed to. */
export function exitError(what: string, exit: ChildExit, stderr: string): AcpAgentSpawnError {
  if (exit.spawnError !== undefined) {
    return new AcpAgentSpawnError(`acp agent failed to start: ${exit.spawnError.message}`, {
      cause: exit.spawnError,
    });
  }
  const how = exit.code !== null ? `exit code ${exit.code}` : `signal ${exit.signal}`;
  const tail = stderr.length > 0 ? `\nlast stderr:\n${stderr}` : "";
  return new AcpAgentSpawnError(`acp agent exited ${what} (${how})${tail}`, {
    exitCode: exit.code,
    signal: exit.signal,
  });
}
