/**
 * Barrel for persistence primitives shared across subsystems
 * (memory, runtime, cron, mcp).
 *
 * No longer published: the `@theokit/sdk/internal/persistence` subpath was removed in the next
 * major. Consumers import the supported primitives from `@theokit/sdk/persistence`. This barrel is
 * now an in-repo module only.
 *
 * Everything reachable through this barrel is an internal primitive and is NOT covered by the
 * package's semver contract.
 */

export type { AtomicWriteJsonOptions } from "./atomic-write.js";
export { atomicWriteJson, atomicWriteText, replaceFileAtomic } from "./atomic-write.js";
export { withCwdMutex } from "./cwd-mutex.js";
export type { CreateExclusiveOptions } from "./exclusive-create.js";
export { createExclusive } from "./exclusive-create.js";
export type { FileLockOptions } from "./file-lock.js";
export { withFileLock } from "./file-lock.js";
export { containsCjk, sanitizeFts5Query } from "./fts5-sanitize.js";
export { appendJsonl, JsonlParseError, loadJsonl, readJsonlIds } from "./jsonl.js";
export { displayTheokitHome, getProfilesRoot, getTheokitHome } from "./paths.js";
export { PersistenceSchema } from "./persistence-schema.js";
export type {
  MigrateSchemaOptions,
  MigrateSchemaResult,
  Migration,
  ReadVersionedJsonOptions,
  SqliteLike,
  VersionedJsonFile,
  VersionedJsonMigrate,
} from "./schema-version.js";
export {
  migrateSchema,
  readVersionedJson,
  writeVersionedJson,
} from "./schema-version.js";
export { casUpdate } from "./sqlite-cas.js";
export type { OpenSqliteResilientOptions, ResilientSqliteDb } from "./sqlite-open.js";
export { isCorruptionError, openSqliteResilient } from "./sqlite-open.js";
export type { WalApplyResult } from "./sqlite-wal.js";
export { applyWalWithFallback } from "./sqlite-wal.js";
