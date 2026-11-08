/**
 * DockerSandbox — runs each command in a throwaway container whose only writable path is the
 * workspace bind mount. The root filesystem is read-only, the network is off by default, all
 * capabilities are dropped and the process runs as the host user, so a shell command cannot write
 * outside `workDir` (it can still change files inside it).
 *
 * Without `workDir` a fresh temp directory is mounted. `exitCode` follows the protocol (0, 1, or 124
 * on timeout), not the command's own code.
 *
 * Needs a reachable Docker daemon and an image with a POSIX `sh`. A missing Docker surfaces as
 * `SandboxNotAvailableError` from `execute`/`uploadFile` instead of silently running on the host.
 *
 * @public
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve as resolveHost } from "node:path";

import {
  type ExecuteResult,
  SandboxBackend,
  type SandboxConfig,
  type SandboxNetworkPolicy,
  SandboxNotAvailableError,
  SandboxSecurityError,
} from "./types.js";

/** Where the host `workDir` appears inside the container. */
const CONTAINER_WORKDIR = "/workspace";

/** Result of one `docker` invocation: captured output, exit code and whether it timed out. */
export interface DockerRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Seam for tests: runs `docker <args>`, optionally feeding `input` to stdin. */
export type DockerRunner = (
  args: readonly string[],
  opts: { input?: string | Buffer; timeoutMs: number; maxOutputBytes: number },
) => Promise<DockerRunResult>;

/** Configuration for {@link DockerSandbox}. */
export interface DockerSandboxConfig extends SandboxConfig {
  /** Image to run. Must contain `sh`. Default `alpine:3`. */
  image?: string;
  /** Allow outbound network. Default `false` (`--network none`). */
  network?: boolean;
  /** Docker binary. Default `docker`. */
  dockerBin?: string;
  /** Replaces the real `docker` process (tests). */
  runner?: DockerRunner;
  /** `uid:gid` the container runs as. Default: the host user. */
  user?: string;
}

function defaultRunner(bin: string): DockerRunner {
  return (args, { input, timeoutMs, maxOutputBytes }) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = (s: string, chunk: Buffer) =>
        s.length >= maxOutputBytes ? s : s + chunk.toString("utf-8");
      child.stdout.on("data", (c: Buffer) => {
        stdout = cap(stdout, c);
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr = cap(stderr, c);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
}

/** Sandbox backend that runs each command in a throwaway Docker container. */
export class DockerSandbox extends SandboxBackend {
  override readonly networkPolicy: SandboxNetworkPolicy;
  private readonly image: string;
  private readonly network: boolean;
  private readonly runner: DockerRunner;
  private readonly hostDir: string;
  private readonly user: string | undefined;

  constructor(config: DockerSandboxConfig = {}) {
    // No workDir ⇒ a fresh private directory, never the host /tmp.
    super({
      ...config,
      workDir: config.workDir ?? mkdtempSync(join(tmpdir(), "theokit-docker-ws-")),
    });
    this.image = config.image ?? "alpine:3";
    this.network = config.network ?? false;
    this.networkPolicy = { mode: this.network ? "unrestricted" : "none" };
    this.runner = config.runner ?? defaultRunner(config.dockerBin ?? "docker");
    this.hostDir = resolveHost(this.config.workDir ?? "/tmp");
    this.user =
      config.user ??
      (typeof process.getuid === "function" && typeof process.getgid === "function"
        ? `${process.getuid()}:${process.getgid()}`
        : undefined);
  }

  /** The `docker run` argv for one command; exposed shape is covered by tests. */
  private runArgs(name: string, interactive: boolean, argv: readonly string[]): string[] {
    return [
      "run",
      "--rm",
      ...(interactive ? ["-i"] : []),
      "--name",
      name,
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--network",
      this.network ? "bridge" : "none",
      ...(this.user ? ["--user", this.user] : []),
      "-v",
      `${this.hostDir}:${CONTAINER_WORKDIR}:rw`,
      "-w",
      CONTAINER_WORKDIR,
      "-e",
      "HOME=/tmp",
      this.image,
      ...argv,
    ];
  }

  private async run(
    interactive: boolean,
    argv: readonly string[],
    timeoutMs: number,
    input?: string | Buffer,
  ): Promise<DockerRunResult> {
    const name = `theokit-sbx-${randomBytes(6).toString("hex")}`;
    const max = this.config.maxOutputBytes ?? 5 * 1024 * 1024;
    let r: DockerRunResult;
    try {
      r = await this.runner(this.runArgs(name, interactive, argv), {
        input,
        timeoutMs,
        maxOutputBytes: max,
      });
    } catch (e) {
      throw new SandboxNotAvailableError(
        `docker could not be started: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (r.timedOut) {
      // Killing the CLI does not stop the container; remove it explicitly.
      await this.runner(["rm", "-f", name], { timeoutMs: 10_000, maxOutputBytes: 4096 }).catch(
        () => undefined,
      );
    }
    return r;
  }

  async execute(command: string, opts?: { timeoutMs?: number }): Promise<ExecuteResult> {
    const timeoutMs = opts?.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    const r = await this.run(false, ["sh", "-c", command], timeoutMs);
    return {
      stdout: this.truncateOutput(r.stdout),
      stderr: this.truncateOutput(r.stderr),
      exitCode: r.timedOut ? 124 : r.code === 0 ? 0 : 1,
      timedOut: r.timedOut,
    };
  }

  async uploadFile(path: string, content: string | Buffer): Promise<void> {
    const target = path.startsWith("/")
      ? posix.normalize(path)
      : posix.normalize(`${CONTAINER_WORKDIR}/${path}`);
    if (target !== CONTAINER_WORKDIR && !target.startsWith(`${CONTAINER_WORKDIR}/`)) {
      throw new SandboxSecurityError(`uploadFile path escapes the workspace: ${path}`);
    }
    const r = await this.run(
      true,
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", target],
      this.config.timeoutMs ?? 30_000,
      content,
    );
    if (r.code !== 0) throw new Error(`uploadFile failed: ${r.stderr.trim() || "docker error"}`);
  }
}
