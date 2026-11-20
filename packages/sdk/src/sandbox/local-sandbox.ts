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

import { execFile, spawn } from "node:child_process";
import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

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

  override async executeStreaming(
    command: string,
    opts?: { timeoutMs?: number; onStdoutLine?: (line: string) => void; signal?: AbortSignal },
  ): Promise<ExecuteResult> {
    const signal = opts?.signal;
    if (signal?.aborted) {
      return { stdout: "", stderr: "aborted", exitCode: 130, timedOut: false };
    }
    const timeout = opts?.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    const max = this.config.maxOutputBytes ?? 5 * 1024 * 1024;

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: this.config.workDir,
        env: resolveChildEnv({ policy: this.config.env }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group, so the kill reaches descendants
      });
      const out = new StreamCollector(max, opts?.onStdoutLine);
      const err = new StreamCollector(max);
      let timedOut = false;
      let aborted = false;
      let done = false;
      const kill = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (code: number | null, spawnFailed: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        out.flush();
        resolve(this.buildStreamResult(out, err, { code, spawnFailed, timedOut, aborted }));
      };
      const watch = (c: StreamCollector) => (chunk: Buffer) => {
        if (c.push(chunk)) kill();
      };
      child.stdout.on("data", watch(out));
      child.stderr.on("data", watch(err));
      child.on("error", () => finish(1, true));
      child.on("close", (code) => finish(code, false));
    });
  }

  private buildStreamResult(
    out: StreamCollector,
    err: StreamCollector,
    end: { code: number | null; spawnFailed: boolean; timedOut: boolean; aborted: boolean },
  ): ExecuteResult {
    const overflowed = out.overflowed || err.overflowed;
    const clean = end.code === 0 && !end.aborted && !overflowed;
    return {
      stdout: this.markIfCut(this.truncateOutput(out.text), overflowed),
      stderr: this.markIfCut(
        this.truncateOutput(end.spawnFailed ? "spawn error" : err.text),
        overflowed,
      ),
      exitCode: end.timedOut ? 124 : clean ? 0 : 1,
      timedOut: end.timedOut,
    };
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

/** Accumulates one stream up to a byte cap, optionally splitting it into lines as chunks arrive. */
class StreamCollector {
  text = "";
  overflowed = false;
  private bytes = 0;
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly max: number,
    private readonly onLine?: (line: string) => void,
  ) {}

  /** Returns true when the cap is exceeded and the child should be killed. */
  push(chunk: Buffer): boolean {
    if (this.overflowed) return true;
    this.bytes += chunk.length;
    const decoded = this.decoder.write(chunk);
    this.text += decoded;
    this.emit(decoded);
    if (this.bytes > this.max) this.overflowed = true;
    return this.overflowed;
  }

  /** Delivers a final unterminated line. */
  flush(): void {
    const tail = this.decoder.end();
    this.text += tail;
    this.emit(tail);
    if (this.onLine && this.pending !== "") this.onLine(this.pending);
    this.pending = "";
  }

  private emit(decoded: string): void {
    if (!this.onLine) return;
    const parts = (this.pending + decoded).split("\n");
    this.pending = parts.pop() ?? "";
    for (const p of parts) this.onLine(p.endsWith("\r") ? p.slice(0, -1) : p);
  }
}
