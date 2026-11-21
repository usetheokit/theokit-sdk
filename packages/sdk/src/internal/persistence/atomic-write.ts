import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, statfs, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { diag } from "../diagnostics.js";

// T5.8 — Linux filesystem magic numbers (from `<linux/magic.h>`).
// Used by `detectNetworkFsName` to identify the parent directory's
// filesystem type from a `statfs()` return value. The four entries
// below cover the network/FUSE cases where `rename()` is best-effort
// rather than strictly atomic; everything else is treated as local.
const NETWORK_FS_MAGIC: ReadonlyMap<number, string> = new Map([
  [0x6969, "nfs"],
  [0x517b, "smb"],
  [0xff534d42, "cifs"],
  [0x65735546, "fuse"],
]);

/**
 * T5.8 — Map a `statfs().type` magic number to a network-FS label, or
 * `null` for local filesystems. Pure function — exported via the
 * `__TESTING__` seam so unit tests can drive the parse logic without
 * needing a network mount.
 *
 * @internal
 */
function detectNetworkFsName(typeMagic: number): string | null {
  return NETWORK_FS_MAGIC.get(typeMagic) ?? null;
}

const warnedNfsDirs = new Set<string>();

/**
 * T5.8 — Best-effort one-shot stderr warning when `dirPath` lives on a
 * network/FUSE filesystem. Silent no-op on local filesystems, on
 * statfs failure (Windows / Node < 18.15 / EACCES), or after the
 * first warning per (dir + label) pair. Mirrors the `sqlite-wal.ts`
 * warn-once-per-label pattern (D63).
 *
 * @internal
 */
async function warnOnNetworkFsOnce(dirPath: string, label: string): Promise<void> {
  const key = `${dirPath}\0${label}`;
  if (warnedNfsDirs.has(key)) return;
  warnedNfsDirs.add(key);
  try {
    const info = await statfs(dirPath);
    const fsName = detectNetworkFsName(info.type);
    if (fsName === null) return;
    diag(
      `[theokit-sdk] ${label}: detected network fs (${fsName}) at ${dirPath} — ` +
        "rename() atomicity guarantees may be weaker than expected.\n",
    );
  } catch {
    // statfs unavailable (Windows / Node < 18.15) or unreadable —
    // silent fallback. The warning is purely informational.
  }
}

/**
 * T5.8 — Test seam exposing the pure detection function so unit tests
 * can assert magic-number coverage without spinning up a network FS.
 * NOT included in the public barrel.
 *
 * @internal
 */
export function __TESTING__detectNetworkFsName(typeMagic: number): string | null {
  return detectNetworkFsName(typeMagic);
}

/**
 * T5.8 — Test seam: clear the per-directory warn-once registry between
 * tests so warning-emission tests stay deterministic.
 *
 * @internal
 */
export function __TESTING__resetNfsWarnings(): void {
  warnedNfsDirs.clear();
}

/**
 * M107 — temp-file creation control, shared by `replaceFileAtomic`,
 * `atomicWriteJson` and `atomicWriteText`.
 *
 * Both fields are OPTIONAL and the default is byte-identical to the behavior
 * before M107. See `replaceFileAtomic` for why the mode reassertion
 * is conditional.
 *
 */
export interface AtomicWriteFileOptions {
  /**
   * Permission bits of the created file. Default: `0o600`, the previous fixed
   * literal — filtered by the `umask`, as it always was. When provided, the mode is
   * reasserted on the descriptor, so the `umask` cannot silently
   * clearing bits the caller asked for.
   */
  mode?: number;
  /**
   * Create the temp file with `wx` (exclusive creation) instead of `w`. Default:
   * `false` — the previous flag. With `true`, a pre-existing temp file becomes
   * `EEXIST` instead of being truncated.
   */
  exclusive?: boolean;
}

/** The one place the temp-path format is written. `atomicWriteTempTarget` reverses it. */
function atomicWriteTempPath(filePath: string, pid: number, suffix: string): string {
  return `${filePath}.${String(pid)}.${suffix}.tmp`;
}

/** Reverses {@link atomicWriteTempPath}: `<file>.<pid>.<hex>.tmp` → `<file>`. */
const TEMP_PATTERN = /^(.+)\.\d+\.[0-9a-f]{16}\.tmp$/;

/**
 * U-9 — the file a leftover temp was replacing, or `undefined` if this is not one of ours.
 *
 * A crash between the open and the rename leaves `<file>.<pid>.<hex>.tmp` behind, and nothing here
 * collects it: this module creates temps and has no opinion about sweeping them. A consumer that
 * wants to has to know the format — which lived only in the implementation, so one copied it out of
 * a compiled chunk as a regex. That copy would have gone on reporting "nothing to collect" the day
 * the format changed, which is the quietest possible way for a cleanup to stop working.
 *
 * Deliberately strict: the pid must be digits and the suffix exactly 16 hex characters. Matching any
 * `.tmp` would claim editors' swap files and other tools' scratch, on a path whose purpose is
 * deleting them.
 */
export function atomicWriteTempTarget(name: string): string | undefined {
  return TEMP_PATTERN.exec(name)?.[1];
}

/**
 * Atomic file replacement: write content to a per-call unique tmp path,
 * fsync, then rename over the target. Crash mid-write leaves either the old
 * file intact or the new file complete — never a half-written file.
 *
 * The tmp suffix is `<pid>.<rand>.tmp` so parallel processes (and concurrent
 * burst writes within one process) never collide on the same tmp path — a
 * race that would manifest as `ENOENT` on `rename` after the rival process
 * already moved its tmp into place.
 *
 * Mirrors peer-project's `replaceFileAtomic` from
 * `reference/peer-project/packages/memory-host-sdk/src/host/fs-utils.ts` with
 * the multi-writer robustness fix.
 *
 * ## M107 — `options` is optional, and the default is byte-identical
 *
 * The third parameter is additive: every earlier caller still compiles and
 * writing exactly the same bytes, with the same mode, to the same path.
 *
 * The mode reassertion (`handle.chmod`) is **conditional on `mode !== undefined`**,
 * and that is not cosmetic. `open`'s mode argument is filtered by the `umask`,
 * which only CLEARS bits — measured in this codebase before the change:
 *
 * ```
 * umask 0o002  ->  0o600      umask 0o022  ->  0o600      umask 0o200  ->  0o400
 * ```
 *
 * An unconditional `chmod` would take the third case from `0o400` to `0o600` — a
 * an on-disk change for every caller that asked for nothing, including external
 * consumers. When the caller DOES ask for a mode, however, letting the `umask` decide
 * silently is the defect this parameter exists to close; hence the reassertion.
 *
 * It goes on the DESCRIPTOR, before the `rename`, never after: chmod-ing the final
 * final one would leave a window where it carries the `umask`'s mode — a known anti-pattern.
 * The chosen shape passes the mode as an `open` argument.
 *
 */
export async function replaceFileAtomic(
  filePath: string,
  content: string,
  options?: AtomicWriteFileOptions,
): Promise<void> {
  // T5.8 — warn once per parent directory if it lives on a network /
  // FUSE filesystem where `rename()` atomicity is best-effort. The
  // write proceeds unchanged; the warning is purely informational so
  // operators can spot the case in stderr / log aggregators.
  await warnOnNetworkFsOnce(dirname(filePath), "atomic-write");
  // T5.7 — crypto-random tmp suffix (CSPRNG, 64 bits of entropy)
  // replaces the predictable `Math.random().toString(36)` source. An
  // attacker observing the process can no longer predict the next
  // tmp path and pre-stage a hostile file to be renamed into place.
  const suffix = randomBytes(8).toString("hex");
  const tmp = atomicWriteTempPath(filePath, process.pid, suffix);
  // T5.7 — mode 0o600 on the tmp file (owner read+write only). The
  // tmp file holds the FULL in-flight content (credential snapshots,
  // OAuth tokens) before the rename. World-readable default would
  // expose secrets during the ms-window between open and rename
  // (TOCTOU). On modern Linux the post-rename target inherits the
  // tmp's permission bits, so the final file is also 0o600.
  const handle = await open(tmp, options?.exclusive === true ? "wx" : "w", options?.mode ?? 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      // Conditional by measurement, not by taste — see this function's docblock.
      if (options?.mode !== undefined) await handle.chmod(options.mode);
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (cause) {
    // EVERY failure after the open removes the temp, not only a rename failure.
    //
    // Cleanup used to sit on the rename alone, so a write error, a full disk or an fsync failure
    // closed the handle in a `finally` and propagated with the temp still on disk. That is not the
    // unfixable case — a process killed mid-write cannot clean up after itself — it is the ordinary
    // error path, and it leaked by construction.
    //
    // Found by this package's own suite pollution gate, which reported a stray
    // `.theokit/agents/registry.json.<pid>.<hex>.tmp` on two separate full runs and not on the ones
    // between. `sweepStaleAtomicTemps` reaps what a crash leaves; this stops the failures that are
    // reachable from inside the process from contributing.
    await unlink(tmp).catch(() => undefined);
    throw cause;
  }
}

/**
 * Options for `atomicWriteJson`.
 *
 */
export interface AtomicWriteJsonOptions extends AtomicWriteFileOptions {
  /** Indent passed to `JSON.stringify`. Default: 2. */
  indent?: number;
  /** Whether to append a trailing newline (POSIX convention). Default: true. */
  trailingNewline?: boolean;
}

/**
 * Typed JSON atomic write helper.
 *
 * Serializes `data` to JSON, then delegates to `replaceFileAtomic`. The
 * parent directory is auto-created (recursive `mkdir`) to make this helper
 * safe for callers who haven't ensured the directory exists (EC-4 in the
 * persistence-state-hardening plan).
 *
 * Throws `TypeError` on circular refs or `undefined` data (propagates from
 * `JSON.stringify`).
 *
 */
export async function atomicWriteJson<T>(
  filePath: string,
  data: T,
  options?: AtomicWriteJsonOptions,
): Promise<void> {
  const indent = options?.indent ?? 2;
  const trailingNewline = options?.trailingNewline ?? true;
  const json = JSON.stringify(data, null, indent);
  if (json === undefined) {
    throw new TypeError("atomicWriteJson: cannot serialize undefined");
  }
  const content = trailingNewline ? `${json}\n` : json;
  await mkdir(dirname(filePath), { recursive: true });
  await replaceFileAtomic(filePath, content, options);
}

/**
 * Atomic text write. Same crash-safety guarantees as `replaceFileAtomic` +
 * auto-mkdir of the parent directory. Written for `theokit-migrate-config` (T4.1, EC-2 MUST FIX) so
 * a crash mid-migration left previous MD files intact rather than corrupting them; that CLI is no
 * longer published, and the guarantee is the reason every other caller uses this too.
 *
 */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await replaceFileAtomic(filePath, content);
}

/**
 * Delete leftover atomic-write temps beside `filePath`, and report what it could not claim.
 *
 * A crash — or a test runner killing a worker — between the `open` and the `rename` leaves
 * `<file>.<pid>.<hex>.tmp` behind. Nothing collected them: `atomicWriteTempTarget` was exported for
 * a caller that never existed, and `packages/sdk/.theokit/agents/` had accumulated **1,984** of them
 * between 2026-05-16 and 2026-09-01.
 *
 * IT RETURNS WHAT IT SKIPPED, and that is the part worth having. Of those 1,984 files only 1,522
 * matched the current `<pid>.<16-hex>.tmp` shape; the other 462 carried an older suffix from before
 * the format changed. A sweeper that only knows today's format leaves 23% behind and reports
 * success — an under-collecting cleanup is worse than an absent one, because the absence is at
 * least visible on disk. Callers that care can log `skipped`; callers that do not still get the
 * honest count rather than a silent one.
 *
 * Best-effort by construction: a directory that cannot be read, or a file that vanishes between the
 * listing and the unlink, is not an error. Sweeping is housekeeping, and housekeeping must never
 * fail the operation it was attached to.
 *
 * @internal
 */
export async function sweepStaleAtomicTemps(
  filePath: string,
): Promise<{ removed: number; skipped: string[] }> {
  const dir = dirname(filePath);
  const target = filePath.slice(dir.length + 1);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0, skipped: [] };
  }
  let removed = 0;
  const skipped: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(`${target}.`) || !name.endsWith(".tmp")) continue;
    if (atomicWriteTempTarget(name) !== target) {
      // Ours by prefix, but not in the shape this module writes today — an older format, or
      // something else entirely. Named rather than deleted: this function must not become a
      // wildcard `.tmp` remover on a path it shares with other tools.
      skipped.push(name);
      continue;
    }
    try {
      await unlink(join(dir, name));
      removed += 1;
    } catch {
      skipped.push(name);
    }
  }
  return { removed, skipped };
}
