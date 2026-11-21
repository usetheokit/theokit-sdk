/**
 * SE41 — `FsSessionStore`, the DEFAULT reference implementation of the pluggable
 * {@link SessionStore} seam. It reads and append-writes the native Claude-shaped
 * `.jsonl` transcript at `<baseDir>/projects/<encoded-cwd>/<agentId>.jsonl` — the
 * exact on-disk format SE40 introduced (the file the Claude Code CLI can
 * `--continue`). Omitting `local.sessionStore` resolves to this store, so the
 * default persistence path is byte-identical to SE40 behavior.
 *
 * `readRecords` is `readTranscript(transcriptPath(...))` (a missing session →
 * `[]`, not an error — a fresh agent has no history). `appendRecords` is a TRUE
 * append: it reads the prior records, concatenates the new-turn delta, and
 * rewrites the whole line set atomically under the SE40 cross-process file lock
 * (`writeTranscript` never shrinks — the native format is an append-only
 * `parentUuid` DAG). The parent dir is created BEFORE acquiring the lock because
 * the lock's companion `<path>.lock` file needs an existing parent dir (the SE40
 * `mkdir(dirname)`-before-lock fix).
 *
 * @internal
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionStore } from "../../types/session-store.js";
import { withFileLock } from "./file-lock.js";
import { appendJsonl } from "./jsonl.js";
import {
  legacyTranscriptPath,
  readTranscript,
  type SessionRecord,
  transcriptPath,
} from "./session-transcript.js";
import { acquireSessionWriter, type SessionWriterLease } from "./session-writer.js";

/** Options identifying the on-disk transcript location for the FS default store. */
export interface FsSessionStoreOptions {
  /** Transcript base dir (`~/.theokit` default, `~/.claude` for CLI interop) — already `~`-expanded. */
  baseDir: string;
  /** The workspace cwd whose encoded form is the transcript project dir. */
  cwd: string;
}

/**
 * Reference-counted leases, shared per path.
 *
 * `acquireSessionWriter` is STRICT on purpose: two concurrent acquisitions of the same path, and
 * exactly one wins — "a lease that let both through would be decorative" (the M81 test says exactly
 * that, and it is right). That is the primitive's contract, and it does not change.
 *
 * But within ONE process it is normal to have more than one store over the same session: the golden
 * compaction tests and the concurrent-send tests do exactly that, and they record real runtime
 * behavior. Applying the raw primitive there would turn a legitimate pattern into a
 * `SessionBusyError`.
 *
 * The reconciliation belongs here, in the primitive's consumer: the process takes ONE lease per path
 * and counts how many stores use it. The last to release actually frees it. Cross-process stays
 * strict — which is the problem M81 states ("`exec resume --last` can write into the TUI's live
 * session").
 */
const sharedLeases = new Map<string, { lease: SessionWriterLease; refs: number }>();

async function acquireShared(path: string): Promise<SessionWriterLease> {
  const existing = sharedLeases.get(path);
  if (existing !== undefined) {
    existing.refs++;
    return createProxy(path);
  }
  const lease = await acquireSessionWriter(path);
  sharedLeases.set(path, { lease, refs: 1 });
  return createProxy(path);
}

/** A handle that decrements the count; the last to release frees the real lease. */
function createProxy(path: string): SessionWriterLease {
  let released = false;
  return {
    sessionPath: path,
    // The proxy forwards the renewal to the ONE real lease this path shares. Renewing through any
    // holder is correct and is the point: the record must say "someone in this process is still
    // writing", and the refcount already guarantees they are all the same owner.
    renew: (): void => {
      if (released) return;
      sharedLeases.get(path)?.lease.renew();
    },
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      const entry = sharedLeases.get(path);
      if (entry === undefined) return;
      entry.refs--;
      if (entry.refs > 0) return;
      sharedLeases.delete(path);
      await entry.lease.release();
    },
  };
}

/**
 * The default `SessionStore` — reads/append-writes the native `.jsonl` transcript.
 */
export class FsSessionStore implements SessionStore {
  readonly #baseDir: string;
  readonly #cwd: string;
  /** One lease per `agentId` — a store serves more than one session over the process lifetime. */
  readonly #leases = new Map<string, SessionWriterLease>();
  /** Memoized per agent so read, append and lease can never disagree about which file is the session. */
  readonly #paths = new Map<string, string>();

  constructor(options: FsSessionStoreOptions) {
    this.#baseDir = options.baseDir;
    this.#cwd = options.cwd;
  }

  /**
   * The file that IS this agent's session.
   *
   * #400 made transcript filenames UUIDs so `claude --continue` can find them. A transcript written
   * before that lives under the old name, and switching to the new one would not lose the file but
   * would abandon it: the agent would start a second, empty history beside its real one. So an
   * existing legacy file wins, and only a session with no file yet gets the new name.
   *
   * Resolved ONCE per agent. Re-deciding per call would let `acquire` lock one path while
   * `appendRecords` wrote another — the lease would be guarding a file nobody was writing.
   */
  #pathFor(agentId: string): string {
    const memoized = this.#paths.get(agentId);
    if (memoized !== undefined) return memoized;
    const canonical = transcriptPath(this.#baseDir, this.#cwd, agentId);
    const legacy = legacyTranscriptPath(this.#baseDir, this.#cwd, agentId);
    const resolved = legacy !== canonical && existsSync(legacy) ? legacy : canonical;
    this.#paths.set(agentId, resolved);
    return resolved;
  }

  async readRecords(agentId: string): Promise<SessionRecord[]> {
    return readTranscript(this.#pathFor(agentId));
  }

  async appendRecords(agentId: string, records: readonly SessionRecord[]): Promise<void> {
    // Empty delta → nothing to persist (avoids an unnecessary lock + rewrite).
    if (records.length === 0) return;
    const path = this.#pathFor(agentId);
    // mkdir BEFORE the lock: withFileLock's companion `<path>.lock` needs the parent dir.
    await mkdir(dirname(path), { recursive: true });

    await withFileLock(path, async () => {
      // M93 — appends the DELTA instead of rewriting the whole file.
      //
      // Before: `readTranscript` + `writeTranscript` of everything, per turn. O(n) of I/O **and** of
      // parsing on every turn, O(n^2) per session — the consumer note in
      // `agents/lib/session/backtrack.ts` records 1.4 MB / 3000 lines over 200 turns.
      //
      // Correct because the format **is already append-only**: the `parentUuid` DAG does not depend
      // on line order, and every record carries its own parent. `appendJsonl` **already existed in
      // the package** and had a single caller (`eval/runner.ts`) — the primitive was there, it was
      // the store that ignored it (rung 4).
      //
      // `withFileLock` stays — but the earlier claim that "it is what serializes two concurrent
      // `appendRecords`" was too strong, and M93's adversarial review measured it: removing it fails
      // no test. The reason is the paragraph above — the `parentUuid` DAG does not depend on line
      // order, so two interleaved batches reconstruct identically. The work the lock was doing
      // (protecting a read-modify-write) disappeared along with the rewrite.
      //
      // What it still covers is the TOCTOU window in `needsLineBreakBefore` (read the last byte,
      // then write): without it, two processes can both conclude "a \n is missing" and produce a
      // blank line — which the reader discards, i.e. benign. It stays as a **declared, not
      // mechanized** defense (the discipline in `error-handling.md` § 4: enumerate the residue
      // rather than let a missing test pass for coverage).
      //
      // `writeTranscript` still exists for **compaction**, the one operation that legitimately
      // rewrites the file.
      for (const record of records) appendJsonl(path, record);
    });
  }

  /**
   * Takes the session's writer lease. Throws `SessionBusyError` when another process holds it.
   *
   * **Explicit, and NOT inside `appendRecords`** — M95's adversarial review measured why that
   * matters: the `SessionStore` contract states that "an `appendRecords` rejection is logged to
   * stderr, NOT thrown to the caller (best-effort write)". Acquiring there made the
   * `SessionBusyError` get **swallowed**, and the result was worse than the original problem:
   * instead of two writers interleaving lines, the loser **lost the turn silently** — nothing on
   * disk, a stderr warning invisible under the TUI, and no way for the caller to react.
   *
   * At init the error reaches someone who can act: `exec` forks to a new id, which is exactly what
   * the error message itself prescribes. It is the difference between failing where a decision is
   * possible and failing where only loss is.
   */
  async acquire(agentId: string): Promise<void> {
    if (this.#leases.has(agentId)) return;
    const path = this.#pathFor(agentId);
    await mkdir(dirname(path), { recursive: true });
    this.#leases.set(agentId, await acquireShared(path));
  }

  /**
   * Releases ONE agent's lease.
   *
   * It exists because `dispose()` releases **every** lease the store holds, and a store injected by
   * the consumer may serve several agents: an init that fails for agent B must not free agent A's
   * lease, which is still live and writing.
   */
  async release(agentId: string): Promise<void> {
    const lease = this.#leases.get(agentId);
    if (lease === undefined) return;
    this.#leases.delete(agentId);
    await lease.release();
  }

  /**
   * Releases every lease this store holds.
   *
   * Without it the `.writer.lock` outlives the process and the next open would have to wait out the
   * heartbeat window — recoverable, but 30 s of waiting after a CLEAN shutdown would be an avoidable
   * defect. Idempotent: calling it twice is not an error.
   */
  async dispose(): Promise<void> {
    const leases = [...this.#leases.values()];
    this.#leases.clear();
    for (const lease of leases) await lease.release();
  }
}
