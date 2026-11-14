import { randomBytes } from "node:crypto";
import { link, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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

/**
 * Replaces a stale lock. A per-generation takeover file (named after the stale holder's nonce) is
 * claimed with `wx`, so one process takes over one stale lock; the lock is re-read and replaced
 * only if the nonce is unchanged and the holder is still dead. Returns false when it lost a race.
 */
async function takeOver(lockPath: string, stale: Holder, nonce: string): Promise<boolean> {
  // The guard is published by hard-linking a fully written file, so it is never seen empty or
  // partial, and nobody has a reason to reap it while its owner proceeds.
  const marker = `${lockPath}.takeover.${stale.nonce}`;
  const guard = await writeClaim(lockPath, nonce, "guard");
  try {
    await link(guard, marker);
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw noHardLinks(lockPath, err);
  } finally {
    await quietUnlink(guard);
  }
  const current = await readHolder(lockPath);
  // Absent: someone may link in right now, so go back through the exclusive link protocol
  // instead of renaming over the path.
  if (!current || current.nonce !== stale.nonce || pidAlive(current.pid)) return false;
  const claim = await writeClaim(lockPath, nonce, "claim");
  try {
    await rename(claim, lockPath);
  } catch (err) {
    await quietUnlink(claim);
    throw err;
  }
  return true;
}

/** Removes takeover files whose generation is no longer the one on disk. */
async function cleanTakeovers(lockPath: string, liveNonce: string | undefined): Promise<void> {
  const prefix = `${basename(lockPath)}.takeover.`;
  let names: string[];
  try {
    names = await readdir(dirname(lockPath));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.slice(prefix.length) !== liveNonce) {
      await quietUnlink(resolve(dirname(lockPath), name));
    }
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
      const after = await readHolder(lockPath).catch(() => null);
      await cleanTakeovers(lockPath, after?.nonce);
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
