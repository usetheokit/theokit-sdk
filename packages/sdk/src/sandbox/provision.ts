/**
 * M6-3 — portable repo provisioner for the eval harness.
 *
 * Clones a repository and checks out a ref into an isolated working dir, issuing
 * every git command through {@link SandboxBackend.execute} (ADR D2 — same code
 * runs on Local/Docker/E2B; never a direct `child_process` import). Promotes
 * theocode's `prepareRepo` (`swebench-provision.ts:37`) onto the SDK's sandbox
 * abstraction.
 *
 * reference: knowledge-base/references/theocode-eval/lib/swebench-provision.ts:37
 * (clone+checkout), :13 (ProvisionError with instanceId).
 *
 * @public
 */

import { TheokitAgentError } from "../errors.js";
import { LocalSandbox } from "./local-sandbox.js";
import { shellEscapePosix } from "./shell-escape.js";
import type { SandboxBackend } from "./types.js";

/**
 * Raised when cloning or checking out a repo fails. Carries the `instanceId`
 * so a batch run can attribute the failure to the offending dataset row.
 */
export class RepoProvisionError extends TheokitAgentError {
  override readonly name = "RepoProvisionError";

  constructor(
    readonly instanceId: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(`[${instanceId}] ${message}`, {
      code: "repo_provision_failed",
      isRetryable: false,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
  }
}

/** Options for {@link provisionRepo}. */
export interface ProvisionRepoOptions {
  /**
   * Clonable repo URL or local path. SECURITY: when this comes from an
   * untrusted dataset, the value is passed to `git clone` after a `--`
   * end-of-options terminator (no flag injection) and with the `ext::`
   * transport disabled (no arbitrary-command transport).
   */
  readonly repoUrl: string;
  /** Branch, tag, or commit SHA to check out. Rejected if it begins with `-`. */
  readonly ref: string;
  /**
   * Unique id for this row — names the target dir and any error. Validated to
   * `[A-Za-z0-9._-]` (no path traversal) since it becomes a directory name.
   */
  readonly instanceId: string;
  /**
   * Timeout in milliseconds for each `git clone` attempt, passed to
   * `sandbox.execute`. Positive and finite. Default: the backend's own command timeout.
   */
  readonly timeoutMs?: number;
  /**
   * Total number of clone attempts (positive integer, default 1). Before another attempt the
   * partial `<instanceId>` directory is removed. With more than one attempt, an already
   * existing `<instanceId>` directory is rejected rather than deleted.
   */
  readonly attempts?: number;
}

/**
 * Reject ids that would escape the workdir or be parsed as a git flag. Must
 * start with an alphanumeric (blocks `.`, `..`, `-foo`, leading-dot names) and
 * thereafter allow only `[A-Za-z0-9._-]`.
 */
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Clone `repoUrl` into `<sandbox workdir>/<instanceId>` and check out `ref`.
 * Returns the absolute `repoDir` (resolved via `git rev-parse --show-toplevel`,
 * which is portable across backends). Throws {@link RepoProvisionError} naming
 * the `instanceId` when clone or checkout exits non-zero.
 *
 * The `sandbox` is optional (V3-5): when omitted, a default {@link LocalSandbox}
 * is used (clones into the process cwd's `<instanceId>`) — pass an explicit
 * sandbox (e.g. `LocalSandbox({ workDir })` / Docker / E2B) to control the workdir.
 */
export function provisionRepo(opts: ProvisionRepoOptions): Promise<{ repoDir: string }>;
export function provisionRepo(
  sandbox: SandboxBackend,
  opts: ProvisionRepoOptions,
): Promise<{ repoDir: string }>;
export async function provisionRepo(
  sandboxOrOpts: SandboxBackend | ProvisionRepoOptions,
  maybeOpts?: ProvisionRepoOptions,
): Promise<{ repoDir: string }> {
  const sandbox = maybeOpts !== undefined ? (sandboxOrOpts as SandboxBackend) : new LocalSandbox();
  const opts = maybeOpts ?? (sandboxOrOpts as ProvisionRepoOptions);
  const { repoUrl, ref, instanceId } = opts;

  // Validate untrusted-derivable inputs before they reach git/the shell.
  if (!SAFE_INSTANCE_ID.test(instanceId)) {
    throw new RepoProvisionError(
      instanceId,
      "invalid instanceId: must match [A-Za-z0-9._-] (no path traversal)",
    );
  }
  if (ref.startsWith("-")) {
    throw new RepoProvisionError(instanceId, `invalid ref: must not begin with '-' (got ${ref})`);
  }

  const { timeoutMs } = opts;
  const attempts = opts.attempts ?? 1;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new RepoProvisionError(instanceId, `invalid timeoutMs: must be positive and finite`);
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RepoProvisionError(instanceId, `invalid attempts: must be a positive integer`);
  }

  const dir = shellEscapePosix(instanceId);
  if (attempts > 1) {
    // Retries delete the target dir, so never do it to a directory that was already there.
    const exists = await sandbox.execute(`test -e ${dir}`);
    if (exists.exitCode === 0) {
      throw new RepoProvisionError(instanceId, "target directory already exists");
    }
  }

  // `--` terminates options (no `--upload-pack=` flag injection); `protocol.ext.allow=never`
  // blocks the `ext::` arbitrary-command transport. `file`/`https` stay allowed.
  const cloneCmd = `git -c protocol.ext.allow=never clone --quiet -- ${shellEscapePosix(repoUrl)} ${dir}`;
  for (let attempt = 1; ; attempt++) {
    const clone = await sandbox.execute(
      cloneCmd,
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
    if (clone.exitCode === 0) break;
    if (attempt >= attempts) {
      throw new RepoProvisionError(instanceId, `clone failed: ${clone.stderr.trim()}`);
    }
    const cleanup = await sandbox.execute(`rm -rf -- ${dir}`);
    if (cleanup.exitCode !== 0) {
      throw new RepoProvisionError(
        instanceId,
        `clone failed: ${clone.stderr.trim()}; cleanup before retry failed: ${cleanup.stderr.trim()}`,
      );
    }
  }

  const top = await sandbox.execute(
    `git -C ${shellEscapePosix(instanceId)} rev-parse --show-toplevel`,
  );
  if (top.exitCode !== 0) {
    throw new RepoProvisionError(instanceId, `resolve repoDir failed: ${top.stderr.trim()}`);
  }
  const repoDir = top.stdout.trim();

  // `ref` is validated above not to begin with `-`, so it cannot be parsed as a flag.
  const checkout = await sandbox.execute(
    `git -C ${shellEscapePosix(repoDir)} checkout --quiet ${shellEscapePosix(ref)}`,
  );
  if (checkout.exitCode !== 0) {
    throw new RepoProvisionError(instanceId, `checkout ${ref} failed: ${checkout.stderr.trim()}`);
  }

  return { repoDir };
}
