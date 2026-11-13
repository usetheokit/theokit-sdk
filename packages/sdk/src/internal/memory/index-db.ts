import { join } from "node:path";

import { openSqliteResilient } from "../persistence/sqlite-open.js";
import { PRAGMA_STATEMENTS, SCHEMA_STATEMENTS } from "./index-schema.js";
import type { MemoryRoot } from "./storage/memory-root.js";

/**
 * Memory index DB handle + opener.
 *
 * M0-5 (plan m0-foundation-expose-primitives): the driver-load + WAL +
 * corruption-recovery (EC-7) plumbing is now the shared `openSqliteResilient`
 * primitive in `internal/persistence`; this module only declares the memory
 * schema application (PRAGMA + SCHEMA) via its `onOpen` callback.
 *
 * Shared with `@theokit/sdk-memory`; see the memory-store barrel.
 */

export interface MemoryDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Array<Record<string, unknown>>;
  };
  /** SQLite `pragma()` access (used by `applyWalWithFallback`). */
  pragma(statement: string, options?: { simple?: boolean }): unknown;
  close(): void;
  /**
   * Load a SQLite loadable extension at the given path.
   *
   * NOTHING IN THIS PACKAGE CALLS IT, and it is not dead. The caller is the `sqlite-vec` package:
   * `loadSqliteVecExtension` hands it this handle and its `load()` does
   * `db.loadExtension(getLoadablePath())` (sqlite-vec@0.1.9 index.mjs:44). An audit read the absent
   * in-repo call site as "dead surface that only exists to be refused" and recommended deleting the
   * member — which would have removed the contract a third-party library depends on. Saying who
   * calls it is what makes that reading impossible next time.
   *
   * On the `node:sqlite` fallback the adapter's Proxy answers with a throwing stub, and that is also
   * deliberate: the throw is caught by `loadSqliteVecExtension` and becomes a
   * `ConfigurationError` with code `sqlite_vec_unavailable`, so the bare `Error` never escapes to a
   * consumer. The stub's message is what ends up as that error's cause.
   */
  loadExtension(path: string): void;
}

/** Options for opening the memory index database. */
export interface OpenDbOptions {
  filePath: string;
  /**
   * When true and opening fails with a corruption error, rename the file aside
   * and create a fresh DB. Default true.
   */
  recoverCorrupt?: boolean;
}

/** Open (creating if needed) the memory index database and apply the schema pragmas. */
export async function openMemoryDb(opts: OpenDbOptions): Promise<MemoryDb> {
  return openSqliteResilient<MemoryDb>({
    filePath: opts.filePath,
    label: "memory-index",
    recoverCorrupt: opts.recoverCorrupt,
    onOpen: (db) => {
      // PRAGMA + SCHEMA run after WAL is applied (handled by openSqliteResilient).
      for (const pragma of PRAGMA_STATEMENTS) db.exec(pragma);
      for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
    },
  });
}

/**
 * `<index root>/.index/memory.sqlite`. Pure path computation.
 *
 * Takes a resolved root rather than a `cwd`: this function used to spell the default layout out
 * again as a string literal — an answer to "where does memory live?" that no search for the shared
 * helper would have found (#463).
 *
 * **The root it is given is the PROJECT store, even when the facts move.** `memory.directory` may
 * point at the directory the Claude Code CLI manages, and that CLI has no index format — putting a
 * binary artefact it does not understand inside a directory it owns is a different decision from
 * putting the facts there, and it was made deliberately. The facts are what a user would lose; the
 * index is derived and rebuildable from them. See `docs/memory-decisions.md` § 1 before relocating
 * this, and `IndexManager.openSqliteInternal` for the caller that keeps the two apart.
 */
export function defaultIndexPath(root: MemoryRoot): string {
  return join(root, ".index", "memory.sqlite");
}
