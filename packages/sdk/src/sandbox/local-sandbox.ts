/**
 * LocalSandbox — subprocess-based execution. **This is NOT an isolation
 * boundary.** It runs the command via `/bin/sh -c` in the SAME OS as the host
 * with the host's filesystem and network fully reachable — it provides NO
 * process, filesystem, or network isolation. Its only safety affordances are:
 *   - a wall-clock timeout (kills a runaway command),
 *   - an output-size cap (bounds memory), and
 *   - env scrubbing (#54): secret-like parent env vars (`*KEY*`/`*SECRET*`/
 *     `*TOKEN*`/`*PASSWORD*`/`*_AUTH*`) are dropped from the child by default
 *     (`SandboxConfig.env`), so a shell tool cannot exfiltrate host secrets via
 *     the environment.
 *
 * For real isolation (untrusted code), use a container/VM backend — NOT this.
 *
 * @public
 */

import { execFile } from "node:child_process";
import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveChildEnv } from "../internal/runtime/lifecycle/env-policy.js";
import {
  type ExecuteResult,
  SandboxBackend,
  type SandboxConfig,
  type SandboxNetworkPolicy,
} from "./types.js";

/**
 * Runs a command with `/bin/sh -c` on the host. NOT an isolation boundary — the
 * module note above states exactly what it does and does not protect.
 *
 *   const sandbox = new LocalSandbox({ workDir: "/srv/repo", timeoutMs: 10_000 });
 *   const { stdout, exitCode, timedOut } = await sandbox.execute("ls -1");
 *
 * Needs a POSIX host with `/bin/sh`. Every helper inherited from
 * {@link SandboxBackend} — `readFile`, `glob`, `grep`, `listDir` — is built on
 * this `execute`, so they inherit that requirement too.
 *
 * How it fails: `execute` NEVER rejects. Every outcome, including a failure to
 * spawn, comes back as an {@link ExecuteResult}; read `timedOut` first
 * (`true` implies `exitCode` 124) and `stderr` for the reason. `uploadFile` DOES
 * reject, with the raw `node:fs` error, on a bad path or missing permission.
 *
 * Traps:
 *  - `exitCode` is not the child's exit code. It is 0, 124 (timed out) or 1 — a
 *    command that exits 3 is reported as 1, so branching on a specific code does
 *    not work here.
 *  - Output beyond `maxOutputBytes` (default 5 MiB) makes Node kill the child.
 *    The result is `exitCode: 1` and `timedOut: false`, with the cut stream
 *    carrying the `...(truncated)` marker described on `ExecuteResult` (#363).
 *    Since `exitCode` is 1 either way, that marker is what tells a lost-output
 *    result from a command that genuinely failed.
 *  - `uploadFile` resolves a relative path against `workDir` but does not contain
 *    it: an absolute path, or one containing `..`, writes wherever the process
 *    can. `workDir` is a starting directory, not a jail.
 *  - Secret-like parent env vars are dropped by default. Passing
 *    `env: "all"` in {@link SandboxConfig} puts the host's API keys back within
 *    reach of any command the agent runs.
 */
export class LocalSandbox extends SandboxBackend {
  /** Runs on the host, so the network is whatever the host's is. */
  override readonly networkPolicy: SandboxNetworkPolicy = { mode: "unrestricted" };

  constructor(config: SandboxConfig = {}) {
    super(config);
  }

  async execute(command: string, opts?: { timeoutMs?: number }): Promise<ExecuteResult> {
    const timeout = opts?.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    const max = this.config.maxOutputBytes ?? 5 * 1024 * 1024;

    return new Promise<ExecuteResult>((resolve) => {
      const child = execFile(
        "/bin/sh",
        ["-c", command],
        {
          cwd: this.config.workDir,
          timeout,
          maxBuffer: max,
          encoding: "utf-8",
          // #54 — scrub secret-like host env vars from the child by default.
          env: resolveChildEnv({ policy: this.config.env }),
        },
        (error, stdout, stderr) => {
          resolve(this.buildResult(error, stdout ?? "", stderr ?? ""));
        },
      );

      // Safety: if child somehow doesn't callback
      child.on("error", () => {
        resolve({ stdout: "", stderr: "spawn error", exitCode: 1, timedOut: false });
      });
    });
  }

  private buildResult(error: Error | null, stdout: string, stderr: string): ExecuteResult {
    const timedOut = error !== null && "killed" in error && (error as { killed: boolean }).killed;
    // #363 — the ONLY reliable signal that output was lost. Node caps the buffer AT `maxBuffer`, so
    // for ASCII output the string comes back exactly at the cap and `truncateOutput`'s `> max` test
    // never fires; a length comparison cannot tell a cut document from a complete one that happens
    // to be that long. The child being killed for overflow can.
    const overflowed =
      error !== null && (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    return {
      stdout: this.markIfCut(this.truncateOutput(stdout), overflowed),
      stderr: this.markIfCut(this.truncateOutput(stderr), overflowed),
      exitCode: timedOut ? 124 : error ? 1 : 0,
      timedOut,
    };
  }

  /**
   * Append the `...(truncated)` marker `ExecuteResult` tells callers to branch on, when the child
   * was killed for exceeding `maxOutputBytes` and this stream is the one sitting at the cap.
   *
   * `truncateOutput` has already run, so an output it marked is left alone rather than marked
   * twice. Node does not say WHICH stream overflowed, so the stream at the cap is the one that
   * lost data — the other, being shorter, is complete.
   */
  private markIfCut(output: string, overflowed: boolean): string {
    if (!overflowed) return output;
    if (output.endsWith("...(truncated)")) return output;
    const max = this.config.maxOutputBytes ?? 5 * 1024 * 1024;
    return Buffer.byteLength(output) >= max ? `${output}\n...(truncated)` : output;
  }

  async uploadFile(path: string, content: string | Buffer): Promise<void> {
    const fullPath = path.startsWith("/") ? path : `${this.config.workDir}/${path}`;
    await mkdir(dirname(fullPath), { recursive: true });
    await fsWriteFile(fullPath, content, "utf-8");
  }
}
