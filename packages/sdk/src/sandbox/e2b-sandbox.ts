/**
 * E2BSandbox — a {@link SandboxBackend} over an E2B cloud sandbox you already created.
 *
 * It takes the `Sandbox` instance from the `e2b` package rather than importing it, so `e2b` is not a
 * dependency of this package: the handle only has to match {@link E2BSandboxHandle}. What it solves:
 *
 * - `commands.run` throws `CommandExitError` for a non-zero exit; that becomes the real `exitCode`.
 * - `TimeoutError` becomes `exitCode` 124 with `timedOut: true`. `SandboxNotRunningError` and
 *   `SandboxUnreachableError` extend `TimeoutError` in e2b but mean the sandbox is gone, so they throw
 *   `SandboxNotAvailableError` instead of reporting a slow command.
 * - Every command gets `envs` (a Dockerfile `ENV` is not applied by E2B templates) and
 *   `NODE_EXTRA_CA_CERTS`, because Node does not trust E2B's egress proxy.
 *
 * Errors are recognised by `name`, so a different copy of `e2b` still matches.
 *
 * @public
 */

import { posix } from "node:path";

import {
  type ExecuteResult,
  SandboxBackend,
  type SandboxConfig,
  type SandboxNetworkPolicy,
  SandboxNotAvailableError,
} from "./types.js";

/** System CA bundle that includes the certificate of E2B's egress proxy. */
export const E2B_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/** The slice of an `e2b` `Sandbox` that {@link E2BSandbox} uses. */
export interface E2BSandboxHandle {
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: { write(path: string, data: string | ArrayBuffer | Blob): Promise<unknown> };
  kill(): Promise<unknown>;
}

/** Configuration for {@link E2BSandbox}. */
export interface E2BSandboxConfig extends SandboxConfig {
  /** The created e2b sandbox. */
  sandbox: E2BSandboxHandle;
  /** Environment for every command (e.g. the template's Dockerfile `ENV` lines). */
  envs?: Record<string, string>;
  /** The egress policy the sandbox was created with; exposed as `networkPolicy`. */
  networkPolicy?: SandboxNetworkPolicy;
}

interface RunFailure {
  name?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  message?: string;
}

/** Sandbox backend that runs commands in an E2B sandbox. */
export class E2BSandbox extends SandboxBackend {
  declare readonly networkPolicy?: SandboxNetworkPolicy;
  private readonly sandbox: E2BSandboxHandle;
  private readonly envs: Record<string, string>;

  constructor(config: E2BSandboxConfig) {
    super({ ...config, workDir: config.workDir ?? "/home/user" });
    this.sandbox = config.sandbox;
    this.envs = { NODE_EXTRA_CA_CERTS: E2B_CA_BUNDLE, ...config.envs };
    if (config.networkPolicy) this.networkPolicy = config.networkPolicy;
  }

  async execute(command: string, opts?: { timeoutMs?: number }): Promise<ExecuteResult> {
    const timeoutMs = opts?.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    try {
      const r = await this.sandbox.commands.run(command, {
        cwd: this.config.workDir,
        envs: this.envs,
        timeoutMs,
      });
      return this.result(r, r.exitCode, false);
    } catch (e) {
      const err = (e ?? {}) as RunFailure;
      if (err.name === "SandboxNotRunningError" || err.name === "SandboxUnreachableError") {
        throw new SandboxNotAvailableError(
          `e2b sandbox is not available: ${err.message ?? err.name}`,
        );
      }
      if (err.name === "CommandExitError") {
        return this.result(err, typeof err.exitCode === "number" ? err.exitCode : 1, false);
      }
      if (err.name === "TimeoutError") return this.result(err, 124, true);
      throw e;
    }
  }

  async uploadFile(path: string, content: string | Buffer): Promise<void> {
    const target = path.startsWith("/")
      ? posix.normalize(path)
      : posix.normalize(`${this.config.workDir ?? "/home/user"}/${path}`);
    const data = typeof content === "string" ? content : new Uint8Array(content).buffer;
    await this.sandbox.files.write(target, data);
  }

  override async dispose(): Promise<void> {
    await this.sandbox.kill().catch(() => undefined);
  }

  private result(
    r: { stdout?: string; stderr?: string },
    exitCode: number,
    timedOut: boolean,
  ): ExecuteResult {
    return {
      stdout: this.truncateOutput(r.stdout ?? ""),
      stderr: this.truncateOutput(r.stderr ?? ""),
      exitCode,
      timedOut,
    };
  }
}
