import { randomBytes } from "node:crypto";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TheokitAgentError } from "../../errors-base.js";

/** A lock held by this process. */
export interface InstanceLock {
  readonly path: string;
  /** Removes the lock if this holder still owns it. Idempotent. */
  release(): Promise<void>;
}

/**
 * Another live process holds the instance lock, or the filesystem cannot take it.
 *
 * @public
 */
export class InstanceLockedError extends TheokitAgentError {
  override readonly name: string = "InstanceLockedError";
  readonly lockPath: string;
  readonly holderPid?: number;

  constructor(message: string, options: { lockPath: string; holderPid?: number; cause?: unknown }) {
    super(message, { isRetryable: false, cause: options.cause });
    this.lockPath = options.lockPath;
    if (options.holderPid !== undefined) this.holderPid = options.holderPid;
  }
}

interface Holder {
  pid: number;
  nonce: string;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 25;

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === "EPERM";
  }
}

function parseHolder(text: string): Holder | undefined {
  try {
    const v = JSON.parse(text) as Partial<Holder>;
    if (Number.isInteger(v.pid) && typeof v.nonce === "string") return v as Holder;
  } catch {
    // fall through
  }
  return undefined;
}

async function readHolder(lockPath: string): Promise<Holder | undefined | null> {
  try {
    return parseHolder(await readFile(lockPath, "utf8"));
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

async function quietUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}

/** Writes this process's claim (pid + nonce) to a private file, mode 0600. */
async function writeClaim(lockPath: string, nonce: string, suffix: string): Promise<string> {
  const claim = `${lockPath}.${suffix}.${process.pid}.${nonce}`;
  await writeFile(claim, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx", mode: 0o600 });
  return claim;
}

function locked(lockPath: string, holderPid?: number): InstanceLockedError {
  const who = holderPid === undefined ? "another process" : `process ${holderPid}`;
  return new InstanceLockedError(
    `Instance lock ${lockPath} is held by ${who}. Stop that process, or remove the lock file if the pid is not running.`,
    { lockPath, ...(holderPid === undefined ? {} : { holderPid }) },
  );
}

function noHardLinks(lockPath: string, cause: unknown): InstanceLockedError {
  return new InstanceLockedError(
    `Cannot take instance lock ${lockPath}: the instance lock needs a filesystem with hard links (link failed: ${errCode(cause) ?? "unknown error"}).`,
    { lockPath, cause },
  );
}

type LinkResult = "taken" | "exists";

async function tryLink(lockPath: string, nonce: string): Promise<LinkResult> {
  const claim = await writeClaim(lockPath, nonce, "claim");
  try {
    await link(claim, lockPath);
    return "taken";
  } catch (err) {
    if (errCode(err) === "EEXIST") return "exists";
    throw noHardLinks(lockPath, err);
  } finally {
    await quietUnlink(claim);
  }
}

const MAX_GUARDS = 16;

/**
 * Publishes a takeover guard for one stale generation: `<lock>.takeover.<staleNonce>.<k>`, a
 * hard link to a fully written file, so it is never seen partial. Guard `k` whose owner is dead
 * (a crashed taker) is superseded by guard `k+1`, never deleted, so a live guard can't be reaped.
 * Returns the guard path when this process owns it, or undefined when a live taker holds one.
 */
async function claimGuard(
  lockPath: string,
  stale: Holder,
  nonce: string,
): Promise<string | undefined> {
  const file = await writeClaim(lockPath, nonce, "guard");
  try {
    for (let k = 0; k < MAX_GUARDS; k++) {
      const guard = `${lockPath}.takeover.${stale.nonce}.${k}`;
      const slot = await claimSlot(lockPath, file, guard);
      if (slot === "taken") return guard;
      if (slot === "live") return undefined;
    }
    return undefined;
  } finally {
    await quietUnlink(file);
  }
}

async function linkOnce(lockPath: string, file: string, guard: string): Promise<boolean> {
  try {
    await link(file, guard);
    return true;
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw noHardLinks(lockPath, err);
  }
}

/** One guard slot: "taken" by us, held by a "live" taker, or "dead" (its taker crashed). */
async function claimSlot(
  lockPath: string,
  file: string,
  guard: string,
): Promise<"taken" | "live" | "dead"> {
  for (let spin = 0; spin < 3; spin++) {
    if (await linkOnce(lockPath, file, guard)) return "taken";
    const owner = await readHolder(guard);
    if (owner === null) continue; // its owner just removed it: try this slot again
    return owner && !pidAlive(owner.pid) ? "dead" : "live";
  }
  return "live";
}

/**
 * Replaces a stale lock. Only the owner of a per-generation takeover guard proceeds; it re-reads
 * the lock and replaces it only if the nonce is unchanged and the holder is still dead. If the
 * lock is gone, it returns false so the caller retries the exclusive link, never a rename over the
 * path. The guard is removed by its owner afterwards. Returns false when it lost a race.
 */
async function takeOver(lockPath: string, stale: Holder, nonce: string): Promise<boolean> {
  const guard = await claimGuard(lockPath, stale, nonce);
  if (!guard) return false;
  try {
    const current = await readHolder(lockPath);
    if (!current || current.nonce !== stale.nonce || pidAlive(current.pid)) return false;
    const claim = await writeClaim(lockPath, nonce, "claim");
    try {
      await rename(claim, lockPath);
    } catch (err) {
      await quietUnlink(claim);
      throw err;
    }
    return true;
  } finally {
    await quietUnlink(guard);
  }
}

function makeLock(lockPath: string, nonce: string): InstanceLock {
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      const holder = await readHolder(lockPath).catch(() => null);
      if (holder && holder.nonce === nonce) await quietUnlink(lockPath);
    },
  };
}

/** One try: true when the lock is ours; false to retry; throws when a live holder owns it. */
async function attemptOnce(lockPath: string, nonce: string): Promise<boolean> {
  if ((await tryLink(lockPath, nonce)) === "taken") return true;
  const holder = await readHolder(lockPath);
  if (holder === null) return false; // vanished between link and read
  if (holder === undefined) throw locked(lockPath);
  if (pidAlive(holder.pid)) throw locked(lockPath, holder.pid);
  return takeOver(lockPath, holder, nonce);
}

/**
 * Takes `<dir>.instance.lock` (or `options.path`) so only one process works on a state directory.
 *
 * The lock is held for the life of the process (call `release()` on shutdown). It is a claim file
 * holding `pid` and a random nonce, hard-linked into place so it is never seen half-written. If
 * the lock exists and its pid is running, this rejects with {@link InstanceLockedError}; if the pid
 * is gone (a crash), the lock is taken over, and only one of several racing processes wins.
 *
 * LIMIT: liveness is `kill(pid, 0)`, so every process contending for the lock must share one pid
 * namespace (same host, same container). Across containers or pid namespaces a live holder can look
 * dead. The filesystem must support hard links.
 *
 * @public
 */
export async function acquireInstanceLock(
  dir: string,
  options: { path?: string } = {},
): Promise<InstanceLock> {
  const lockPath = resolve(options.path ?? `${resolve(dir)}.instance.lock`);
  const nonce = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    if (await attemptOnce(lockPath, nonce)) return makeLock(lockPath, nonce);
  }
  const last = await readHolder(lockPath).catch(() => null);
  throw locked(lockPath, last?.pid);
}
