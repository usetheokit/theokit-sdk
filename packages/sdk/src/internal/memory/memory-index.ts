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
 */

import type { IndexStatus, MemorySearchHit, SearchOptions } from "./index-manager-contract.js";

// Re-export consumer-facing shapes for stable internal import paths.
export type { IndexStatus, MemorySearchHit, SearchOptions };

export interface SyncResult {
  filesScanned: number;
  filesUpdated: number;
  chunksWritten: number;
  chunksEmbedded: number;
  /**
   * Whether this backend actually walked a corpus.
   *
   * REQUIRED, not optional, and that is the point. `MemoryIndex` has two implementers and consumers
   * hold the interface: `IndexManager` walks files, and `LanceMemoryAdapter` has no corpus to walk —
   * it is a vector store fed by explicit `addFacts`. The adapter used to answer with a frozen
   * all-zeros result, which a caller cannot tell apart from a real sync that found nothing to do.
   * The comment above it stated that as the intention ("so callers' existing logging does not
   * break"), which is the substitution defect written down as a feature.
   *
   * A required boolean forces every implementer to say which case it is in, and forces the compiler
   * to notice a new implementer that forgot. An optional flag would have let the next backend
   * reproduce the silence.
   */
  supported: boolean;
}

/**
 * Common search-options parser used by both `IndexManager.search` and
 * `LanceMemoryAdapter.search`. Returns the normalized cap + minimum-score
 * floor — eliminates jscpd duplication while keeping per-backend search
 * logic distinct.
 */
export function parseSearchOptions(options: SearchOptions = {}): {
  maxResults: number;
  minScore: number;
} {
  return {
    maxResults: Math.max(1, options.maxResults ?? 10),
    minScore: options.minScore ?? 0,
  };
}

export interface MemoryIndex {
  /**
   * Walk the memory corpus + reindex changed files. Lance backend has no
   * markdown corpus to walk — its adapter returns zero counts (no-op) and
   * relies on explicit `addFact` calls instead.
   */
  sync(): Promise<SyncResult>;

  /**
   * Semantic + textual search over the indexed corpus. Both backends
   * return the same `MemorySearchHit[]` shape; Lance leaves `textScore`
   * undefined (vector-only — no FTS5 layer).
   */
  search(query: string, options?: SearchOptions): Promise<MemorySearchHit[]>;

  /** Snapshot of the index health (backend type + counts). */
  status(): IndexStatus;

  /** Release native handles. Idempotent. */
  close(): Promise<void> | void;
}
