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

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve as resolveHost } from "node:path";

import { ConfigurationError } from "../errors.js";
import { diag } from "../internal/diagnostics.js";
import { KEEP_LABEL, removeEarlierKept } from "./docker-containers.js";
import { type DockerRunner, type DockerRunResult, defaultDockerRunner } from "./docker-runner.js";
import { dockerEndpoint, openDockerTerminal } from "./docker-terminal.js";

export { type DockerRunner, type DockerRunResult, defaultDockerRunner };

import {
  type ExecuteResult,
  SandboxBackend,
  type SandboxConfig,
  type SandboxNetworkPolicy,
  SandboxNotAvailableError,
  SandboxSecurityError,
  type SandboxTerminal,
  type SandboxTerminalOptions,
} from "./types.js";

/** Where the host `workDir` appears inside the container. */
const CONTAINER_WORKDIR = "/workspace";

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
  /** Mount the workspace read-only (`:ro`). Default `false`. `uploadFile` then fails. */
  readOnlyWorkspace?: boolean;
  /** Labels added to every container this sandbox starts (`--label k=v`). */
  labels?: Readonly<Record<string, string>>;
  /** Keep the most recent container of this key after it exits (no --rm); earlier exited ones with the same key are removed. */
  keepLast?: { key: string };
}

const LABEL_KEY = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

/** Validates labels and returns a private copy, so later mutation cannot bypass the check. */
function validateLabels(labels: Readonly<Record<string, string>> | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!LABEL_KEY.test(key)) {
      throw new ConfigurationError(`Invalid Docker label key "${key}": must match ${LABEL_KEY}`, {
        code: "invalid_docker_label",
      });
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new ConfigurationError(
        `Invalid Docker label value for key "${key}": must be a string without newlines`,
        { code: "invalid_docker_label" },
      );
    }
    out.push([key, value]);
  }
  return out;
}

/** Validates `keepLast`, appends its reserved label to `labels` and returns the key. */
function applyKeepLast(
  keepLast: { key: string } | undefined,
  labels: [string, string][],
): string | undefined {
  if (keepLast === undefined) return undefined;
  const key = keepLast.key;
  if (typeof key !== "string" || key === "" || /[\r\n]/.test(key)) {
    throw new ConfigurationError("keepLast.key must be a non-empty string without newlines", {
      code: "invalid_docker_label",
    });
  }
  if (labels.some(([k]) => k === KEEP_LABEL)) {
    throw new ConfigurationError(`Label "${KEEP_LABEL}" is reserved for keepLast`, {
      code: "invalid_docker_label",
    });
  }
  labels.push([KEEP_LABEL, key]);
  return key;
}

/** Sandbox backend that runs each command in a throwaway Docker container. */
export class DockerSandbox extends SandboxBackend {
  override readonly networkPolicy: SandboxNetworkPolicy;
  private readonly image: string;
  private readonly network: boolean;
  private readonly runner: DockerRunner;
  private readonly hostDir: string;
  private readonly user: string | undefined;
  private readonly readOnlyWorkspace: boolean;
  private readonly labels: readonly [string, string][];
  private readonly keepKey: string | undefined;
  /** Opens a TTY exec in a dedicated container; see `openContainerTerminal`. */
  override openTerminal?: (
    command: string,
    opts: SandboxTerminalOptions,
  ) => Promise<SandboxTerminal>;

  constructor(config: DockerSandboxConfig = {}) {
    // No workDir ⇒ a fresh private directory, never the host /tmp.
    super({
      ...config,
      workDir: config.workDir ?? mkdtempSync(join(tmpdir(), "theokit-docker-ws-")),
    });
    const labels = validateLabels(config.labels);
    this.keepKey = applyKeepLast(config.keepLast, labels);
    this.labels = labels;
    this.readOnlyWorkspace = config.readOnlyWorkspace ?? false;
    this.image = config.image ?? "alpine:3";
    this.network = config.network ?? false;
    this.openTerminal = (command, opts) => {
      const name = `theokit-sbx-${randomBytes(6).toString("hex")}`;
      const args = this.runArgs(name, false, ["tail", "-f", "/dev/null"]);
      return openContainerTerminal(this.runner, args, name, command, opts);
    };
    this.networkPolicy = { mode: this.network ? "unrestricted" : "none" };
    this.runner = config.runner ?? defaultDockerRunner(config.dockerBin);
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
      ...(this.keepKey === undefined ? ["--rm"] : []),
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
      ...this.labels.flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      "-v",
      `${this.hostDir}:${CONTAINER_WORKDIR}:${this.readOnlyWorkspace ? "ro" : "rw"}`,
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
    if (this.keepKey !== undefined) {
      await removeEarlierKept(this.runner, this.keepKey, name).catch((e) =>
        diag(
          `DockerSandbox keepLast cleanup failed for key "${this.keepKey}": ${e instanceof Error ? e.message : String(e)}\n`,
        ),
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

/**
 * Opens `command` under a TTY in a dedicated container, attached through the Docker Engine API
 * (`DOCKER_HOST` `unix://` or `tcp://`; `dockerBin` and a custom `runner` apply only to creating
 * and removing the container). The container has the same confinement as `execute` and is removed
 * when the terminal ends, even with `keepLast`.
 */
async function openContainerTerminal(
  runner: DockerRunner,
  args: string[],
  name: string,
  command: string,
  opts: SandboxTerminalOptions,
): Promise<SandboxTerminal> {
  args.splice(1, 0, "-d");
  const remove = once(async () => {
    await runner(["rm", "-f", name], { timeoutMs: 10_000, maxOutputBytes: 4096 });
  });
  try {
    const r = await runner(args, { timeoutMs: 60_000, maxOutputBytes: 65_536 });
    if (r.code !== 0 || r.timedOut) throw new Error(r.stderr.trim() || "docker run failed");
  } catch (e) {
    await remove().catch(() => undefined);
    throw new SandboxNotAvailableError(
      `docker could not be started: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    return await openDockerTerminal({
      endpoint: dockerEndpoint(),
      container: name,
      command,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? CONTAINER_WORKDIR,
      onEnd: remove,
    });
  } catch (e) {
    await remove().catch(() => undefined);
    throw e;
  }
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let p: Promise<void> | undefined;
  return () => {
    p ??= fn();
    return p;
  };
}
