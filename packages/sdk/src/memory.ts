import { MEMORY_EMBEDDING_ADAPTERS } from "./internal/memory/adapters/catalog.js";
import { runDreamingSweep as runDreamingSweepInternal } from "./internal/memory/dreaming/run.js";
import { tryLoadSdkMemoryPeer } from "./internal/memory/sdk-memory-peer-loader.js";
import { type MemoryRoot, resolveMemoryRoot } from "./internal/memory/storage/memory-root.js";

/**
 * Public handle to an open memory index. Mirrors the internal `MemoryIndex`
 * contract structurally; defined here (NOT re-exported from internal/) so
 * the public DTS surface does not pull the internal/runtime cycle that
 * trips rollup-plugin-dts.
 *
 * @public
 */
export interface MemoryIndexHandle {
  sync(): Promise<{
    filesScanned: number;
    filesUpdated: number;
    chunksWritten: number;
    chunksEmbedded: number;
    /**
     * Whether this backend actually walked a corpus. `false` on the Lance backend, which is a
     * vector store fed by explicit writes and has no corpus — its zero counts mean "not applicable",
     * not "nothing to reindex". Read this before treating the counts as a measurement.
     */
    supported: boolean;
  }>;
  search(
    query: string,
    options?: {
      maxResults?: number;
      minScore?: number;
      sources?: ReadonlyArray<"memory" | "sessions" | "wiki">;
    },
  ): Promise<
    ReadonlyArray<{
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      textScore: number;
      vectorScore?: number;
      snippet: string;
      source: "memory" | "sessions" | "wiki";
      citation: string;
    }>
  >;
  status(): {
    backend: "fts-only" | "hybrid";
    filesIndexed: number;
    chunksIndexed: number;
    lastSyncMs?: number;
    /**
     * Whether `filesIndexed` / `chunksIndexed` were measured. `false` on the Lance backend, whose
     * store is async while `status()` is not — the zeros there are placeholders, so
     * `chunksIndexed > 0` is not a valid test for "is the index populated".
     */
    countsExact: boolean;
  };
  close(): Promise<void> | void;
}

/**
 * Inputs for {@link Memory.runDreamingSweep}.
 *
 * `embedding` is required and has no default: the sweep scores cosine similarity between facts, so
 * without real embeddings there is nothing to dedup or cluster on. Both thresholds are cosine
 * similarity in [0, 1] and default to `0.95` for dedup and `0.75` for clustering — dedup is the
 * stricter of the two because merging two facts that were merely related is a data loss, while
 * failing to cluster them only costs a note.
 *
 * @public
 */
export interface DreamingSweepOptions {
  /** Workspace cwd holding `.theokit/memory/`. */
  cwd: string;
  /**
   * Absolute path (or `~/`-prefixed) of the memory root to sweep, when the agent that wrote it set
   * `memory.directory`. Defaults to `<cwd>/.theokit/memory`.
   */
  directory?: string;
  /**
   * Embedding provider for semantic dedup + clustering. Required — dreaming
   * relies on real embeddings to score cosine similarity. Supported providers:
   * `"openai"`, `"mistral"`, `"openrouter"`, `"voyage"`, `"deepinfra"`,
   * `"ollama"` (local, ADR D183).
   */
  embedding: {
    provider: "openai" | "mistral" | "openrouter" | "voyage" | "deepinfra" | "ollama";
    model?: string;
  };
  /** Cosine-similarity threshold for the dedup phase. Default `0.95`. */
  dedupThreshold?: number;
  /** Cosine-similarity threshold for the clustering phase. Default `0.75`. */
  clusterThreshold?: number;
}

/**
 * What one dreaming sweep did.
 *
 * `status` is `"skipped"` when the workspace held no facts to work on and `"error"` when the sweep
 * failed; both come back with every counter at zero, so check `status` before reading a zero as
 * "there was nothing to consolidate". A failure is reported through this field rather than as a
 * rejection, which means a caller that only awaits the promise never learns the sweep did nothing.
 * `factsBefore` and `factsAfter` bracket the run, which is the pair to compare when you want to
 * know whether the sweep was worth running rather than how many operations it performed.
 *
 * @public
 */
export interface DreamingSweepResult {
  status: "ok" | "skipped" | "error";
  factsBefore: number;
  factsAfter: number;
  duplicatesRemoved: number;
  clustersCreated: number;
  notesWritten: number;
  /** Deduplicated facts past the per-sweep cap that this sweep did not cluster. */
  factsLeftOut?: number;
}

/**
 * Options for `Memory.openIndex`. Mirrors the internal `OpenIndexOptions`
 * but using only public types from the SDK surface.
 *
 * @public
 */
export interface OpenMemoryIndexOptions {
  /** Workspace cwd holding `.theokit/memory/`. */
  cwd: string;
  /** Override storage file path (SQLite) OR storage directory (Lance). */
  filePath?: string;
  /**
   * Embedding runtime — REQUIRED for `backend: "lance"`, optional for
   * `"sqlite-vec"` (when omitted, SQLite runs FTS-only without vector
   * recall).
   */
  embedding?: {
    provider: "openai" | "mistral" | "openrouter" | "voyage" | "deepinfra" | "ollama";
    model?: string;
  };
  /** Default `"sqlite-vec"`. Set to `"lance"` to opt into LanceDB (peer dep). */
  backend?: "sqlite-vec" | "lance";
}

/**
 * Memory operations that run OUTSIDE an agent turn.
 *
 * Everything here is reachable without `Agent.create({ memory: ... })`, which is the point: opening
 * an index directly is how a CLI or a maintenance job inspects or rebuilds what the agent will
 * later read, and the dreaming sweep is maintenance that no `send()` triggers.
 *
 * Both operations route through the `@theokit/sdk-memory` peer package when it is installed and
 * fall back to the in-tree implementation when it is not. The fallback is not a degraded mode —
 * behaviour and thrown errors match — so consumers do not branch on which path ran.
 *
 * @public
 */
export const Memory = {
  /**
   * Open a memory index. Dispatches to SQLite-vec (default, zero deps) or
   * LanceDB (opt-in via `backend: "lance"`, requires `@lancedb/lancedb`
   * peer dep + an embedding runtime).
   *
   * Returns a `MemoryIndex` with `sync()`, `search(query, opts?)`,
   * `status()`, and `close()`. Use this when you want a direct index
   * handle outside of `Agent.create({ memory: ... })`.
   *
   * @throws ConfigurationError({code:"invalid_memory_backend"}) for typos
   *   like `"lancedb"`.
   * @throws ConfigurationError({code:"lance_requires_embedding"}) when
   *   `backend: "lance"` is requested without `embedding`.
   * @throws ConfigurationError({code:"lance_backend_unavailable"}) when
   *   `backend: "lance"` is requested but the peer dep is absent.
   *
   * @public
   */
  async openIndex(opts: OpenMemoryIndexOptions): Promise<MemoryIndexHandle> {
    // SDK 2.0 Phase 4 (Stage 4, iter 77): if @theokit/sdk-memory is
    // installed, route through it. Otherwise fall back to the legacy
    // internal path. Behavior + thrown errors are byte-equivalent
    // because sdk-memory's IndexManager + MEMORY_EMBEDDING_ADAPTERS
    // are hybrid copies of sdk-core's internals (iter 44-75).
    const peer = await tryLoadSdkMemoryPeer();
    const openArgs = buildIndexOpenArgs(opts, undefined);
    if (peer !== null) {
      openArgs.embedding = await resolveEmbedding(opts.embedding, peer.MEMORY_EMBEDDING_ADAPTERS);
      // biome-ignore lint/suspicious/noExplicitAny: peer is dynamically loaded — structural compat ensured by sdk-memory
      return (await peer.IndexManager.open(openArgs as any)) as MemoryIndexHandle;
    }
    // Fallback path — sdk-memory peer absent; use the internal
    // implementation (v1.x behavior preserved).
    // Lazy import to avoid pulling internal/runtime types into the public
    // DTS surface (rollup-plugin-dts trips on a pre-existing cycle in
    // types/agent.ts ↔ fork-agent.ts when reached transitively).
    const { IndexManager } = await import("./internal/memory/index-manager.js");
    openArgs.embedding = await resolveEmbedding(opts.embedding, MEMORY_EMBEDDING_ADAPTERS);
    // Cast: structural-compat (internal MemoryIndex matches MemoryIndexHandle).
    // biome-ignore lint/suspicious/noExplicitAny: embedding is resolved from the same catalog — types match at runtime
    return (await IndexManager.open(openArgs as any)) as MemoryIndexHandle;
  },

  /**
   * Run a dreaming sweep: dedup near-duplicate facts, cluster thematically
   * related ones, and write a consolidated note + diary entry.
   *
   * @public
   */
  async runDreamingSweep(opts: DreamingSweepOptions): Promise<DreamingSweepResult> {
    // SDK 2.0 Phase 4 (Stage 4, iter 77): route through sdk-memory
    // when installed; fall back to legacy internal/ path otherwise.
    const peer = await tryLoadSdkMemoryPeer();
    const catalog = peer !== null ? peer.MEMORY_EMBEDDING_ADAPTERS : MEMORY_EMBEDDING_ADAPTERS;
    const sweepArgs = await buildDreamingSweepArgs(opts, catalog);
    const result =
      peer !== null
        ? // biome-ignore lint/suspicious/noExplicitAny: peer is dynamically loaded — structural compat ensured by sdk-memory
          await peer.runDreamingSweep(sweepArgs as any)
        : // biome-ignore lint/suspicious/noExplicitAny: legacy path accepts the same shape
          await runDreamingSweepInternal(sweepArgs as any);
    return toDreamingSweepResult(result);
  },
};

// ---------------------------------------------------------------------------
// Internal helpers — deduplicate patterns shared across peer + legacy paths.
// ---------------------------------------------------------------------------

/** Catalog shape shared between sdk-memory peer and local MEMORY_EMBEDDING_ADAPTERS. */
interface EmbeddingCatalog {
  [provider: string]: { create(opts: Record<string, unknown>): Promise<unknown> } | undefined;
}

/**
 * Resolve an embedding runtime from a provider catalog. Throws the canonical
 * "Unknown embedding provider" error when the provider is not in the catalog.
 */
async function resolveEmbedding(
  embeddingOpts: { provider: string; model?: string } | undefined,
  catalog: EmbeddingCatalog,
): Promise<unknown> {
  if (embeddingOpts === undefined) return undefined;
  const adapter = catalog[embeddingOpts.provider];
  if (adapter === undefined) {
    throw new Error(
      `Unknown embedding provider "${embeddingOpts.provider}". Supported: ${Object.keys(catalog).join(", ")}.`,
    );
  }
  return adapter.create(embeddingOpts.model !== undefined ? { model: embeddingOpts.model } : {});
}

interface IndexOpenArgs {
  cwd: string;
  filePath?: string;
  embedding?: unknown;
  backend?: "sqlite-vec" | "lance";
}

/** Build the args object for IndexManager.open from user-facing options. */
function buildIndexOpenArgs(opts: OpenMemoryIndexOptions, embedding: unknown): IndexOpenArgs {
  return {
    cwd: opts.cwd,
    ...(opts.filePath !== undefined ? { filePath: opts.filePath } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
  };
}

interface DreamingSweepArgs {
  cwd: string;
  /** Resolved once here so the facts, the notes and the diary all land in one place (#463). */
  memoryRoot: MemoryRoot;
  embedding: unknown;
  dedupThreshold?: number;
  clusterThreshold?: number;
}

/** Build args for runDreamingSweep from user-facing options + resolved embedding. */
async function buildDreamingSweepArgs(
  opts: DreamingSweepOptions,
  catalog: EmbeddingCatalog,
): Promise<DreamingSweepArgs> {
  const runtime = await resolveEmbedding(opts.embedding, catalog);
  return {
    cwd: opts.cwd,
    memoryRoot: resolveMemoryRoot(opts.cwd, { directory: opts.directory }),
    embedding: runtime,
    ...(opts.dedupThreshold !== undefined ? { dedupThreshold: opts.dedupThreshold } : {}),
    ...(opts.clusterThreshold !== undefined ? { clusterThreshold: opts.clusterThreshold } : {}),
  };
}

/** Normalize a raw dreaming sweep result into the public DreamingSweepResult shape. */
function toDreamingSweepResult(result: {
  status: string;
  factsBefore: number;
  factsAfter: number;
  duplicatesRemoved: number;
  clustersCreated: number;
  notesWritten: number;
  factsLeftOut?: number;
}): DreamingSweepResult {
  return {
    status: result.status as DreamingSweepResult["status"],
    factsBefore: result.factsBefore,
    factsAfter: result.factsAfter,
    duplicatesRemoved: result.duplicatesRemoved,
    clustersCreated: result.clustersCreated,
    notesWritten: result.notesWritten,
    ...(result.factsLeftOut !== undefined ? { factsLeftOut: result.factsLeftOut } : {}),
  };
}
