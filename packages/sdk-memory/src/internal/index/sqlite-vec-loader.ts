import type { MemoryDb } from "@theokit/sdk/internal/memory-store";

// `isSqliteVecLoaded` has no SDK counterpart yet, so it stays here; the loader is the SDK's.
export { loadSqliteVecExtension } from "@theokit/sdk/internal/memory-store";

/** Check whether sqlite-vec is loaded by running a tiny version query. */
export function isSqliteVecLoaded(db: MemoryDb): boolean {
  try {
    const row = db.prepare("SELECT vec_version() as v").get();
    return row !== undefined && row.v !== undefined;
  } catch {
    return false;
  }
}
