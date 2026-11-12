// #1065: `loadSqliteVecExtension` is owned by @theokit/sdk (semver-exempt subpath).
// `isSqliteVecLoaded` has no SDK counterpart, so it stays here.
import { loadSqliteVecExtension, type MemoryDb } from "@theokit/sdk/internal/memory-store";

export { loadSqliteVecExtension };

/** Check whether sqlite-vec is loaded by running a tiny version query. */
export function isSqliteVecLoaded(db: MemoryDb): boolean {
  try {
    const row = db.prepare("SELECT vec_version() as v").get();
    return row !== undefined && row.v !== undefined;
  } catch {
    return false;
  }
}
