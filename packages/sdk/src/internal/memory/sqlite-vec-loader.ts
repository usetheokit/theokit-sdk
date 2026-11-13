import { ConfigurationError } from "../../errors.js";
import type { MemoryDb } from "./index-db.js";

/**
 * Load the `sqlite-vec` extension into an opened SQLite connection.
 *
 * Wraps the native `load(db)` call from the `sqlite-vec` npm package with a
 * typed error path (EC-8 of the edge-case review) so callers see a
 * `sqlite_vec_unavailable` ConfigurationError instead of a raw native error.
 *
 */
export async function loadSqliteVecExtension(db: MemoryDb): Promise<void> {
  try {
    const mod = await import("sqlite-vec");
    const loadFn = (mod as { load?: (db: unknown) => void }).load;
    if (typeof loadFn !== "function") {
      throw new Error("sqlite-vec module exposes no `load` export");
    }
    loadFn(db);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigurationError(
      `sqlite-vec extension unavailable. Install \`sqlite-vec\` and ensure the native binary matches your Node + OS. Cause: ${message}`,
      { code: "sqlite_vec_unavailable", cause },
    );
  }
}
