/**
 * Command resolution and child-process handling for `connectAcpAgent`.
 *
 * @internal
 */

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { TheokitAgentError } from "@theokit/sdk";

/** Number of trailing stderr lines kept for diagnostics. */
const STDERR_MAX_LINES = 20;
/** Cap on one kept stderr line, in characters. */
const STDERR_MAX_LINE_CHARS = 500;
const KILL_GRACE_MS = 2_000;

/**
 * A child agent could not be started, was refused before starting, or exited before it finished
 * what it was asked to do.
 *
 * @public
 */
export class AcpAgentSpawnError extends TheokitAgentError {
  override readonly name: string = "AcpAgentSpawnError";
  /** Exit code of the child, when it exited with one. */
  readonly exitCode?: number | null;
  /** Signal that ended the child, when it was killed by one. */
  readonly exitSignal?: string | null;
  /** The last (bounded) stderr lines of the child. */
  readonly stderrTail?: string;

  constructor(
    message: string,
    details: {
      exitCode?: number | null;
      exitSignal?: string | null;
      stderrTail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      ...(details.cause !== undefined ? { cause: details.cause } : {}),
    });
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.exitSignal !== undefined) this.exitSignal = details.exitSignal;
    if (details.stderrTail !== undefined) this.stderrTail = details.stderrTail;
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

/**
 * Resolve `command` to an absolute executable path. Throws `AcpAgentSpawnError` before anything is
 * spawned when the command is a relative path, when `PATH` holds a relative or empty entry, or when
 * nothing executable is found. Only the `PATH` of the supplied `env` is read, never `process.env`.
 */
export function resolveCommand(command: string, env: Record<string, string>): string {
  if (command.length === 0) throw new AcpAgentSpawnError("ACP agent command is empty");
  if (isAbsolute(command)) {
    if (isExecutableFile(command)) return command;
    throw new AcpAgentSpawnError(`ACP agent command not found or not executable: ${command}`);
  }
  if (command.includes("/") || command.includes("\\")) {
    throw new AcpAgentSpawnError(
      `ACP agent command "${command}" is a relative path; use an absolute path or a bare command name`,
    );
  }
  return resolveOnPath(command, env.PATH ?? "");
}

function resolveOnPath(command: string, pathValue: string): string {
  const entries = pathValue.split(delimiter);
  if (entries.some((entry) => entry === "" || !isAbsolute(entry))) {
    throw new AcpAgentSpawnError(
      `refusing to resolve "${command}": PATH has a relative or empty entry`,
    );
  }
  const found = entries.map((entry) => join(entry, command)).find(isExecutableFile);
  if (found === undefined) {
    throw new AcpAgentSpawnError(`ACP agent command not found on PATH: ${command}`);
  }
  return found;
}

/** A spawned child with bounded stderr capture and an exit promise. */
export interface AgentChild {
  readonly process: ChildProcess;
  /** Resolves once, when the child has exited. Never rejects. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** The last stderr lines, joined by newlines. */
  stderrTail(): string;
  /** Terminate the child (its process group on POSIX) and wait for it to exit. */
  kill(): Promise<void>;
  hasExited(): boolean;
}

function trackStderr(child: ChildProcess): () => string {
  const lines: string[] = [];
  let partial = "";
  const push = (line: string): void => {
    lines.push(line.slice(0, STDERR_MAX_LINE_CHARS));
    if (lines.length > STDERR_MAX_LINES) lines.shift();
  };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = (parts.pop() ?? "").slice(-STDERR_MAX_LINE_CHARS);
    for (const part of parts) push(part);
  });
  return () =>
    (partial.length > 0 ? [...lines, partial] : lines).slice(-STDERR_MAX_LINES).join("\n");
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // the group or process is already gone
  }
}

/** Spawn the resolved command. Rejects with `AcpAgentSpawnError` when the OS refuses to start it. */
export function spawnAgentChild(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<AgentChild> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stderrTail = trackStderr(child);
    let exitedFlag = false;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.once("close", (code, signal) => {
        exitedFlag = true;
        done({ code, signal });
      });
      child.once("error", () => {
        if (child.pid === undefined) {
          exitedFlag = true;
          done({ code: null, signal: null });
        }
      });
    });
    child.once("error", (err) => {
      if (child.pid === undefined) {
        reject(new AcpAgentSpawnError(`failed to spawn ${file}: ${err.message}`, { cause: err }));
      }
    });
    child.once("spawn", () => {
      child.stdin?.on("error", () => {});
      resolve({
        process: child,
        exited,
        stderrTail,
        hasExited: () => exitedFlag,
        async kill() {
          if (!exitedFlag) {
            signalGroup(child, "SIGTERM");
            const timer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
            await exited;
            clearTimeout(timer);
          }
          // Descendants may outlive the leader; sweep the group once more.
          signalGroup(child, "SIGKILL");
        },
      });
    });
  });
}
