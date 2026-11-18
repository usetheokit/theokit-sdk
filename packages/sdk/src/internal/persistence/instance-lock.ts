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
 * 3. A dead pid is taken over. The taker claims a per-generation guard file `<lock>.takeover.<gen>.<k>`
 *    with `wx` (content `{ pid, nonce }`), so only one live process takes over a given stale lock. A
 *    guard whose recorded pid is dead (a crashed taker) is skipped for slot `k+1`, never deleted, so a
 *    live guard cannot be removed. The taker re-reads the lock and replaces it only if it is
 *    unchanged and its holder is still dead. Up to 3 attempts.
 * 4. `release()` unlinks the lock only if the nonce is still this holder's own, then removes its
 *    own guards (only those whose content still carries its nonce). A failed unlink rejects, and a
 *    later `release()` retries.
 *
 * ## Limit
 *
 * Liveness is `kill(pid, 0)`, so every process contending for a lock must share one pid namespace
 * (not across containers or hosts sharing a volume). A filesystem without hard links is refused.
 *
 * @internal
 */

import { createHash, randomBytes } from "node:crypto";
import { link, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { TheokitAgentError } from "../../errors-base.js";
import { createExclusive } from "./exclusive-create.js";

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
  /** Runs inside `release()`, after the lock is removed and before the guards are cleaned. */
  /** Runs after a takeover guard is published, before the lock is re-read. */
  afterGuardPublished?: () => Promise<void>;
  beforeGuardCleanup?: () => Promise<void>;
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

/** Unlinks `path`, tolerating only a file that is already gone. */
async function unlinkStrict(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
export function acquireInstanceLock(
  dir: string,
  options?: { path?: string },
): Promise<InstanceLock> {
  return acquireWithHooks(dir, options, {});
}

/** @internal */
export async function acquireWithHooks(
  dir: string,
  options: { path?: string } | undefined,
  hooks: InstanceLockHooks,
): Promise<InstanceLock> {
  const lockPath = resolve(options?.path ?? `${resolve(dir)}.instance.lock`);
  const nonce = randomBytes(16).toString("hex");
  const content = JSON.stringify({ pid: process.pid, nonce });
  const claimPath = `${lockPath}.claim.${process.pid}.${nonce}`;
  const guards: string[] = [];

  if (!(await createExclusive(claimPath, content, { mode: 0o600 }))) {
    throw new Error(`instance lock claim file already exists: ${claimPath}`);
  }
  try {
    await takeLock(lockPath, claimPath, hooks, guards, content);
  } catch (e) {
    await unlinkQuiet(claimPath);
    throw e;
  }
  await unlinkQuiet(claimPath);

  let releasing: Promise<void> | undefined;
  let released = false;
  const doRelease = async (): Promise<void> => {
    const raw = await readLock(lockPath);
    if (raw !== undefined && parseHolder(raw).nonce === nonce) await unlinkStrict(lockPath);
    await hooks.beforeGuardCleanup?.();
    // Only a guard that still carries our nonce is ours; a path can be re-published by a later
    // generation's taker.
    for (const g of guards) {
      const body = await readLock(g).catch(() => undefined);
      if (body !== undefined && parseHolder(body).nonce === nonce) await unlinkQuiet(g);
    }
    released = true;
  };
  return {
    path: lockPath,
    // Concurrent calls share one attempt; a failed attempt is dropped so the next call retries.
    release: () => {
      if (released) return Promise.resolve();
      releasing ??= doRelease().catch((e) => {
        releasing = undefined;
        throw e;
      });
      return releasing;
    },
  };
}

/** Links the claim to the lock path. True when taken, false on `EEXIST`. */
async function tryLink(lockPath: string, claimPath: string): Promise<boolean> {
  try {
    await link(claimPath, lockPath);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw new InstanceLockedError(
      lockPath,
      undefined,
      `cannot take the instance lock ${lockPath}: it needs a filesystem with hard links ` +
        `(link failed: ${code ?? String(e)})`,
    );
  }
}

async function takeLock(
  lockPath: string,
  claimPath: string,
  hooks: InstanceLockHooks,
  guards: string[],
  content: string,
): Promise<void> {
  let takeovers = 0;
  while (!(await tryLink(lockPath, claimPath))) {
    const raw = await readLock(lockPath);
    if (raw === undefined) continue; // released meanwhile
    const { pid } = parseHolder(raw);
    if (pid !== undefined && isAlive(pid)) throw new InstanceLockedError(lockPath, pid);
    await hooks.afterStaleRead?.();
    if (takeovers++ >= TAKEOVER_ATTEMPTS) throw new InstanceLockedError(lockPath, pid);
    if (await takeOver(lockPath, claimPath, raw, guards, content, hooks)) return;
  }
}

/** Whether the taker that published `guard` is dead, alive, or the guard vanished. */
async function guardOwner(guard: string): Promise<"dead" | "live" | "gone"> {
  for (let i = 0; i < 3; i++) {
    const body = await readLock(guard);
    if (body === undefined) return "gone";
    const { pid } = parseHolder(body);
    if (pid !== undefined) return isAlive(pid) ? "live" : "dead";
    await new Promise((r) => setTimeout(r, 10)); // its owner may still be writing it
  }
  return "live"; // unreadable owner: never treat it as dead
}

/** Claims the first free guard slot of a generation, skipping guards left by dead takers. */
async function claimGuard(base: string, content: string, guards: string[]): Promise<boolean> {
  for (let k = 0; ; ) {
    const guard = `${base}.${k}`;
    if (await createExclusive(guard, content, { mode: 0o600 })) {
      guards.push(guard);
      return true;
    }
    const owner = await guardOwner(guard);
    if (owner === "live") return false;
    if (owner === "dead") k++;
  }
}

/** Replaces the stale lock `raw` with our claim. False when someone else got there first. */
async function takeOver(
  lockPath: string,
  claimPath: string,
  raw: string,
  guards: string[],
  content: string,
  hooks: InstanceLockHooks,
): Promise<boolean> {
  // Derived from the stale content itself, so every contender names the same guard, even when the
  // content is malformed and carries no nonce.
  const generation = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  if (!(await claimGuard(`${lockPath}.takeover.${generation}`, content, guards))) {
    await new Promise((r) => setTimeout(r, 25));
    return false; // a live process owns this generation; the caller re-reads the lock
  }
  await hooks.afterGuardPublished?.();
  const again = await readLock(lockPath);
  if (again !== raw) return false;
  const pid = parseHolder(again).pid;
  if (pid !== undefined && isAlive(pid)) return false;
  // Atomic replace: the lock is never absent, so no plain `link` can slip in between.
  await rename(claimPath, lockPath);
  return true;
}
