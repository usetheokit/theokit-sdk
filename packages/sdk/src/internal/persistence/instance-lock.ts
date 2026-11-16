/**
 * Single-instance lock for a state directory: one process per directory, held for the life of the
 * process, with takeover of a lock left by a crashed holder.
 *
 * `withFileLock` is a critical-section lock and cannot answer "who holds it"; this one is held until
 * `release()` and names the holder.
 *
 * ## Protocol
 *
 * 1. Write a claim file (`wx`, mode 0600) holding `{ pid, nonce }`, then hard-link it to the lock
 *    path. The lock appears with its full content or not at all, never half-written.
 * 2. `EEXIST`: read the holder. A live pid is refused with {@link InstanceLockedError}.
 * 3. A dead pid is taken over. The taker claims a per-generation guard file with `wx`, so only one
 *    process takes over a given stale lock, re-reads the lock, and replaces it only if it is
 *    unchanged and its holder is still dead. Up to 3 attempts.
 * 4. `release()` unlinks the lock only if the nonce is still this holder's own.
 *
 * ## Limit
 *
 * Liveness is `kill(pid, 0)`, so every process contending for a lock must share one pid namespace
 * (not across containers or hosts sharing a volume). A filesystem without hard links is refused.
 *
 * @internal
 */

import { randomBytes } from "node:crypto";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { TheokitAgentError } from "../../errors-base.js";

/** A held instance lock. */
export interface InstanceLock {
  readonly path: string;
  /** Removes the lock if this holder still owns it. Idempotent. */
  release(): Promise<void>;
}

/** Another live process holds the instance lock, or the filesystem cannot hold one. */
export class InstanceLockedError extends TheokitAgentError {
  override readonly name = "InstanceLockedError";
  readonly lockPath: string;
  readonly holderPid?: number;

  constructor(lockPath: string, holderPid?: number, message?: string) {
    super(
      message ??
        `another process (pid ${holderPid}) holds the instance lock ${lockPath}. Stop that process, ` +
          "or remove the lock file if that pid is not running.",
      { code: "instance_locked", isRetryable: false },
    );
    this.lockPath = lockPath;
    if (holderPid !== undefined) this.holderPid = holderPid;
  }
}

/** Test seam: runs after the stale lock was read, before the takeover is attempted. */
export interface InstanceLockHooks {
  afterStaleRead?: () => Promise<void>;
}

const TAKEOVER_ATTEMPTS = 3;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseHolder(raw: string): { pid?: number; nonce?: string } {
  try {
    const v = JSON.parse(raw) as { pid?: unknown; nonce?: unknown };
    return {
      ...(typeof v.pid === "number" ? { pid: v.pid } : {}),
      ...(typeof v.nonce === "string" ? { nonce: v.nonce } : {}),
    };
  } catch {
    return {};
  }
}

async function readLock(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}

/**
 * Takes `<dir>.instance.lock` (or `options.path`) for the life of the process.
 *
 * Rejects with {@link InstanceLockedError} when a live process holds it (`holderPid` names it), or
 * when the filesystem has no hard links. A lock left by a pid that is not running is taken over.
 *
 * Liveness is `kill(pid, 0)`: every process contending for the lock must share one pid namespace.
 */
export function acquireInstanceLock(dir: string, options?: { path?: string }): Promise<InstanceLock> {
  return acquireWithHooks(dir, options, {});
}

/** @internal */
export async function acquireWithHooks(
  dir: string,
  options: { path?: string } | undefined,
  hooks: InstanceLockHooks,
): Promise<InstanceLock> {
  const lockPath = options?.path ?? `${resolve(dir)}.instance.lock`;
  const nonce = randomBytes(16).toString("hex");
  const content = JSON.stringify({ pid: process.pid, nonce });
  const claimPath = `${lockPath}.claim.${process.pid}.${nonce}`;
  const guards: string[] = [];

  await writeFile(claimPath, content, { flag: "wx", mode: 0o600 });
  try {
    await takeLock(lockPath, claimPath, hooks, guards);
  } catch (e) {
    await unlinkQuiet(claimPath);
    throw e;
  }
  await unlinkQuiet(claimPath);

  let releasing: Promise<void> | undefined;
  const doRelease = async (): Promise<void> => {
    const raw = await readLock(lockPath);
    if (raw !== undefined && parseHolder(raw).nonce === nonce) await unlinkQuiet(lockPath);
    for (const g of guards) await unlinkQuiet(g);
  };
  return {
    path: lockPath,
    release: () => {
      releasing ??= doRelease();
      return releasing;
    },
  };
}

async function takeLock(
  lockPath: string,
  claimPath: string,
  hooks: InstanceLockHooks,
  guards: string[],
): Promise<void> {
  let takeovers = 0;
  for (;;) {
    try {
      await link(claimPath, lockPath);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new InstanceLockedError(
          lockPath,
          undefined,
          `cannot take the instance lock ${lockPath}: it needs a filesystem with hard links ` +
            `(link failed: ${(e as NodeJS.ErrnoException).code ?? String(e)})`,
        );
      }
    }
    const raw = await readLock(lockPath);
    if (raw === undefined) continue; // released meanwhile
    const holder = parseHolder(raw);
    if (holder.pid !== undefined && isAlive(holder.pid)) {
      throw new InstanceLockedError(lockPath, holder.pid);
    }
    await hooks.afterStaleRead?.();
    if (takeovers++ >= TAKEOVER_ATTEMPTS) throw new InstanceLockedError(lockPath, holder.pid);
    if (await takeOver(lockPath, claimPath, raw, guards)) return;
  }
}

/** Replaces the stale lock `raw` with our claim. False when someone else got there first. */
async function takeOver(
  lockPath: string,
  claimPath: string,
  raw: string,
  guards: string[],
): Promise<boolean> {
  const generation = parseHolder(raw).nonce ?? randomBytes(4).toString("hex");
  const guard = `${lockPath}.takeover.${generation}`;
  try {
    await writeFile(guard, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      await new Promise((r) => setTimeout(r, 25));
      return false; // another process owns this generation; the caller re-reads the lock
    }
    throw e;
  }
  guards.push(guard);
  const again = await readLock(lockPath);
  if (again !== raw) return false;
  const pid = parseHolder(again).pid;
  if (pid !== undefined && isAlive(pid)) return false;
  // Atomic replace: the lock is never absent, so no plain `link` can slip in between.
  await rename(claimPath, lockPath);
  return true;
}
