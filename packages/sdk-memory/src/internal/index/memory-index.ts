/**
 * Common `MemoryIndex` interface shared between the SQLite-backed
 * `IndexManager` (default) and the Lance-backed adapter (ADR D43, shipped
 * v1.4.0 via lancedb-backend-ship-v1-1 plan).
 *
 * Consumers (`local-agent-memory.ts`, `active-memory.ts`, `tools.ts`,
 * `runActiveMemory`) only ever call `sync()`, `search()`, `status()`,
 * `close()` — the union of those four methods is the portable surface.
 *
 * Why a separate file (vs declaring inline in `index-manager.ts`)? D43
 * promised "extract an abstract `MemoryIndex` interface in
 * `internal/memory/index-interface.ts`". Keeping the contract physically
 * separated from one of its implementations preserves OCP — future
 * backends (Qdrant, PGVector) can land without touching IndexManager.
 *
 * Iter 50 (Stage 3 source-move #7): hybrid copy from sdk-core's
 * `internal/memory/memory-index.ts`. sdk-core retains its copy for v1.x
 * back-compat; sdk-memory ships the canonical copy that future
 * `index-manager`, `lance-memory-adapter`, and `active-memory` moves
 * will target as siblings.
 *
 * **Iter 50 side-effect:** by publicly re-exporting `MemorySearchHit`
 * via the sdk-memory barrel, this file creates the FIRST reachable
 * downstream consumer for `MemorySearchHit` inside sdk-memory's
 * graph. That unblocks the rollup-plugin-dts treeshake limitation
 * the iter 48 inline-duplicate workaround was guarding against —
 * `internal/active-memory-types.ts` can now re-import the canonical
 * `MemorySearchHit` from `./index-manager-contract.js` and drop its
 * inline mirror. Deletion of that workaround lands in this same iter.
 *
 * @internal
 */

import type { IndexStatus, MemorySearchHit, SearchOptions } from "./index-manager-contract.js";

// NOTE: the canonical sdk-core copy re-exports
// `IndexStatus`/`MemorySearchHit`/`SearchOptions` here for stable
// internal import paths. In sdk-memory the public barrel already does
// `export * from "./internal/index-manager-contract.js"` (iter 47),
// so re-exporting them a second time from this file confuses
// rollup-plugin-dts and triggers a "is not defined" emit error
// (rollup#4860-class pattern). Internal sdk-memory consumers should
// import these types directly from `./index-manager-contract.js`.

/**
 * What one `sync()` did. `filesScanned` counts every markdown file discovered,
 * including the unchanged ones; `filesUpdated` counts only those whose content
 * hash moved. `chunksEmbedded` is 0 on an index with no embedding runtime, and
 * also on a hybrid index where every chunk already had a vector.
 */
export interface SyncResult {
  filesScanned: number;
  filesUpdated: number;
  chunksWritten: number;
  chunksEmbedded: number;
}

// One implementation, shared with the SDK. The types stay local: the SDK's `SyncResult` and
// `IndexStatus` carry required fields (`supported`, `countsExact`) the Lance adapter and
// `IndexManager` here do not set yet.
export { parseSearchOptions } from "@theokit/sdk/internal/memory-store";

/**
 * The four operations both backends implement, and the type every consumer
 * should hold. `IndexManager.open` returns this rather than a concrete class
 * precisely so `backend: "lance"` can be swapped in without changing the caller.
 *
 * The two backends differ in what they can honour, and the differences are
 * visible in the results rather than in the types — see `sync` and `search`
 * below, and `LanceMemoryAdapter` for the full list.
 */
export interface MemoryIndex {
  /**
   * Walk the memory corpus + reindex changed files. Lance backend has no
   * markdown corpus to walk — its adapter returns zero counts (no-op) and
   * relies on explicit `addFact` calls instead.
   */
  sync(): Promise<SyncResult>;

  /**
   * Semantic + textual search over the indexed corpus. Both backends
   * return the same `MemorySearchHit[]` shape; Lance reports `textScore` as 0
   * on every hit, because it is vector-only and has no FTS5 layer.
   */
  search(query: string, options?: SearchOptions): Promise<MemorySearchHit[]>;

  /** Snapshot of the index health (backend type + counts). */
  status(): IndexStatus;

  /** Release native handles. Idempotent. */
  close(): Promise<void> | void;
}
