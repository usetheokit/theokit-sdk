/**
 * Published as `@theokit/sdk/persistence`.
 *
 * Public persistence primitives (V2-3 — Theo Harness Capability Map, Theme G).
 *
 * Promotes the consumer-grade persistence helpers from `internal/persistence`
 * to a STABLE, semver-protected public sub-path so consumers (e.g. a code
 * assistant's eval harness or config store) adopt durable JSONL persist/resume,
 * audited atomic-write, and resilient-SQLite bootstrap WITHOUT coupling to the
 * semver-exempt `@theokit/sdk/internal/persistence` path.
 *
 * Several of these were extracted FROM a real consumer (theocode's SWE-bench
 * harness — see the `reference:` comments in `internal/persistence/jsonl.ts`);
 * this sub-path lets that consumer adopt its own contributed pattern back from a
 * stable home. DTS is generated via tsc (this barrel reaches `internal/`, like
 * `retry`/`compaction` — see `tsconfig.tools-dts.json`).
 */

// Atomic file write (fsync + 0o600 + crypto-random temp + rename; never a torn write).
export type { AtomicWriteJsonOptions } from "./internal/persistence/atomic-write.js";
export {
  atomicWriteJson,
  atomicWriteTempTarget,
  atomicWriteText,
  replaceFileAtomic,
} from "./internal/persistence/atomic-write.js";
// SE43 DoD#2 — shared kernel primitives consumed by published satellites
// (sdk-cache / sdk-memory / sdk-tools), promoted from the `internal`-named export
// to this sanctioned public barrel (final_report.md § MEDIUM — internal/persistence).
export { withCwdMutex } from "./internal/persistence/cwd-mutex.js";
// Cross-process advisory file lock.
export type { FileLockOptions } from "./internal/persistence/file-lock.js";
export { withFileLock } from "./internal/persistence/file-lock.js";
export { sanitizeFts5Query } from "./internal/persistence/fts5-sanitize.js";
// JSONL persist / resume (durable, crash-safe batch runners).
export {
  appendJsonl,
  JsonlParseError,
  loadJsonl,
  readJsonlIds,
} from "./internal/persistence/jsonl.js";
// SE40 — native session transcript (Claude-shaped `.jsonl`, theokit-native). The
// on-disk session format IS this shape. `encodeProjectDir` + `transcriptPath` are
// the path helpers a consumer reuses to locate a session file under
// `<baseDir>/projects/<encoded-cwd>/<sessionId>.jsonl`. Supersedes the SE39
// read-only `ClaudeCodeTranscriptWriter` (removed in v4.0).
//
// Publishing a path helper looks like a storage detail escaping the `SessionStore`
// port, and an audit read it that way. It is not: the port speaks the native
// record shape by design and never claimed to hide the layout — see
// `types/session-store.ts`, which says so in the same words. These helpers
// describe where the DEFAULT `FsSessionStore` writes; a consumer supplying
// `local.sessionStore` is not bound by them.
// #577 — the way BACK. Every helper above goes id → path; a consumer that enumerates
// `projects/<encoded-cwd>/*.jsonl` — which is how you list sessions without a registry — got
// filenames it could not relate to any agent id it held.
//
// The naming scheme is deliberately one-way (a UUIDv8 over SHA-256, so the CLI can `--continue` a
// session this SDK wrote), and the CHANGELOG says "nothing has to be persisted to map one back to
// the other". That is true of the SCHEME and was not true in PRACTICE: the function computing it
// lived in zero `.d.ts`, so the only way to match a filename was to reimplement the hash — an SDK
// internal, in a consumer, silently wrong the day the scheme moves.
//
// So what crosses is the FORWARD mapping, not an inverse. `sessionUuidFor(id)` is what a caller
// matches its own ids against; a true path → id inverse cannot exist and promising one would be a
// lie about a hash. `legacyTranscriptPath` crosses with it because a directory written before #400
// holds both spellings, and a consumer matching only the new one reports old sessions as missing —
// the same false absence, one rename later.
//
// Measured on `@theokit/agents` 4.x against 5.0.1: 29 unit tests failing from this one cause, seen
// from four angles (listing, protection, GC, deletion).
// #598 — the ENUMERATION. Every helper below maps forward; none listed, so two independent consumers
// rebuilt the listing in opposite directions and both derived the id from the filename. One of them
// shipped a garbage collector that classified the live session as an orphan.
//
// It reports where each id came from rather than returning a bare string, because an id that is
// sometimes read and sometimes inferred is the same defect one layer up — see the module docblock.
export {
  type ListSessionsOptions,
  listSessions,
  type SessionIdSource,
  type SessionListing,
} from "./internal/persistence/list-sessions.js";
export { PersistenceSchema } from "./internal/persistence/persistence-schema.js";
export {
  classifySessionArtifact,
  type SessionArtifact,
} from "./internal/persistence/session-artifacts.js";
export {
  encodeProjectDir,
  legacyTranscriptPath,
  sessionUuidFor,
  transcriptPath,
  // M94 — the transcript state's root. Exported because the consumer duplicated it in
  // THREE files, and all three copies ignored `THEOKIT_HOME` along with this one.
  transcriptRoot,
} from "./internal/persistence/session-transcript.js";
export {
  acquireSessionWriter,
  SessionBusyError,
  type SessionWriterLease,
  // M95 — query without taking: asking by taking creates the contention it meant to detect.
  sessionHasWriter,
} from "./internal/persistence/session-writer.js";
// Resilient SQLite bootstrap (corruption recovery) + WAL/FK setup.
export type {
  OpenSqliteResilientOptions,
  ResilientSqliteDb,
} from "./internal/persistence/sqlite-open.js";
export { isCorruptionError, openSqliteResilient } from "./internal/persistence/sqlite-open.js";
export type { WalApplyResult } from "./internal/persistence/sqlite-wal.js";
export { applyWalWithFallback } from "./internal/persistence/sqlite-wal.js";
// M81 — transcript operations the consumer used to perform by hand INSIDE this store.
//
// `agent-builder` wrote into the session store with a raw `writeFileSync` (243 LoC reimplementing
// parsing, truncation and writing of a format that is ours) because nothing here was reachable.
// The rule that protects these operations travels with them: `forkTranscript` refuses to write over
// a live session — moving the operation without the rule would ship an API able to erase exactly
// what the rule exists to protect.
/**
 * @deprecated Renamed to {@link LiveTranscriptError}. The root barrel exports a DIFFERENT class
 * under this name (`session-guard.ts`, about refusing to destroy a session), and a consumer holding
 * both got two classes `instanceof` could not tell apart while `err.name` matched both. This alias
 * keeps existing imports working; it will be removed in the next major.
 */
export {
  type ForkTranscriptOptions,
  forkTranscript,
  LiveTranscriptError,
  LiveTranscriptError as LiveSessionError,
  type ReadJsonlTailOptions,
  readJsonlTail,
} from "./internal/persistence/transcript-ops.js";
// M94 — the record shape stops being `Record<string, unknown>`; the consumer used to litter casts.
export type { TranscriptBlock, TranscriptMessage } from "./types/session-record.js";
