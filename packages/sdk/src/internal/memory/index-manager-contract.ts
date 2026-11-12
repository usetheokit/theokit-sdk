import type { EmbeddingRuntime } from "./embedding-adapter.js";
import type { MemoryRoot } from "./storage/memory-root.js";

/**
 * Memory index manager contract — leaf types shared by `index-manager.ts`
 * (orchestrator), `index-manager-dispatch.ts` (backend dispatch), `lance-memory-adapter.ts`
 * (Lance backend), and `memory-index.ts` (common search-options parsing).
 *
 * **T2.1 / Cycles #11 + #12 + #13 of plan `arch-review-fixes-2026-06-06`
 * (ADR D433):** the previous layout had `index-manager.ts` defining the
 * contract types AND importing runtime from `index-manager-dispatch.ts`;
 * `index-manager-dispatch.ts` importing the types back from `index-manager.ts`;
 * `lance-memory-adapter.ts` and `memory-index.ts` both importing types from
 * `index-manager.ts`. The result was three HIGH-severity cycles
 * (Phase 5 cartographer):
 *
 *   #11: index-manager.ts ↔ index-manager-dispatch.ts (2-node)
 *   #12: index-manager.ts → index-manager-dispatch.ts → lance-memory-adapter.ts → index-manager.ts (3-node)
 *   #13: index-manager.ts → index-manager-dispatch.ts → lance-memory-adapter.ts → memory-index.ts → index-manager.ts (4-node)
 *
 * Single ~60 LOC extraction breaks all three: every cluster member now
 * imports types from this contract; only the orchestrator imports runtime
 * functions from dispatch (one direction, no cycle).
 *
 * **Contract scope:** types only. No runtime code. The single non-cycle
 * import (`EmbeddingRuntime` from `embedding-adapter.ts`) is itself a leaf
 * dependency outside the cluster — does not re-introduce a cycle.
 *
 * NOT part of the `@theokit/sdk` public API.
 */

export interface MemorySearchHit {
  /** Path relative to the memory root. */
  path: string;
  startLine: number;
  endLine: number;
  /** Combined score (hybrid when vector backend active, else just textScore). */
  score: number;
  /** FTS5 BM25 score normalized to 0..1 (higher = better). */
  textScore: number;
  /** sqlite-vec distance normalized to 0..1 (higher = better). Omitted when vector backend disabled. */
  vectorScore?: number;
  snippet: string;
  source: "memory" | "sessions" | "wiki";
  /** path:startLine-endLine for citations. */
  citation: string;
}

export interface IndexStatus {
  backend: "fts-only" | "hybrid";
  filesIndexed: number;
  chunksIndexed: number;
  lastSyncMs?: number;
  /**
   * Whether `filesIndexed` / `chunksIndexed` were MEASURED, or are placeholders.
   *
   * `IndexManager` counts rows with `SELECT COUNT(*)` and reports `true`. `LanceMemoryAdapter`
   * reports `false`: its backing store is async and `status()` is not, so it hardcoded zeros while
   * claiming `backend: "hybrid"` — and a caller deciding "is the index populated?" from
   * `chunksIndexed > 0` got a false negative on every run, however many rows the table held.
   *
   * The zeros stay zero. Inventing a count would trade one false claim for another; what this flag
   * fixes is a caller reading a placeholder as a measurement.
   */
  countsExact: boolean;
}

export interface SearchOptions {
  maxResults?: number;
  minScore?: number;
  sources?: ReadonlyArray<"memory" | "sessions" | "wiki">;
  /** 0..1 — vector vs text weight in hybrid scoring (D4). Default 0.6. */
  vectorWeight?: number;
  /** 0..1 — text weight in hybrid scoring. Default 0.4. */
  textWeight?: number;
}

/** Vector backend selector. SQLite default; Lance opt-in (ADR D43). */
export type MemoryBackend = "sqlite-vec" | "lance";

export interface OpenIndexOptions {
  cwd: string;
  /**
   * The memory root to index and to place the database under. Defaults to `<cwd>/.theokit/memory`.
   *
   * Optional HERE and required everywhere below, deliberately. This is a public entry point whose
   * caller may legitimately have only a workspace; inside an agent the root is resolved once from
   * `memory.directory` and passed in, which is what keeps the index and the writer looking at the
   * same directory (#463).
   */
  memoryRoot?: MemoryRoot;
  filePath?: string;
  /** When provided, vector index is enabled in hybrid mode. */
  embedding?: EmbeddingRuntime;
  /** Vector backend. Default and only value today: `"sqlite-vec"`. */
  backend?: MemoryBackend;
}
