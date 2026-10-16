// Public API surface for @theokit/sdk-memory (SDK 2.0 Phase 1 / T1.6).
//
// Concrete `MemoryProvider` impls consuming the kernel-facing port from
// `@theokit/sdk`. Today: an in-process markdown-backed impl. Next iters
// ship LanceDB + embeddings + active-memory cache.

export {
  createInMemoryMarkdownProvider,
  type InMemoryMarkdownProviderOptions,
} from "./in-memory-provider.js";

// Iter 75: thirty-eighth Stage 3 file move (FINAL) — active-memory
// orchestrator (296 LOC). The recall blocking primitive (ADR D6)
// that runs BEFORE `agent.send` assembles the system prompt. Composes
// every prior Stage 3 move: ActiveMemoryCache (iter 51), CircuitBreaker
// (iter 44), MemorySearchHit (iter 47), MemoryIndex (iter 50),
// active-memory-types (iter 48), persistActiveMemoryTranscript
// (iter 58). `runActiveMemory(args)` + `RunActiveMemoryArgs` +
// `ActiveMemoryOptions`. Inlined telemetry types (OTelSpan +
// TelemetryHandle structural mirrors + 2 constant strings —
// sdk-core's `internal/telemetry/` is not public; the mirrors only
// satisfy local type checking). **CLOSES Stage 3 source-move** —
// all 38 files now canonical in @theokit/sdk-memory.
export * from "./internal/active-memory/active-memory.js";

// Iter 44: first Stage 3 file move — CircuitBreaker copied from sdk-core's
// internal/memory/circuit-breaker.ts. sdk-core retains its copy for v1.x
// active-memory back-compat; sdk-memory's canonical copy is what future
// rich providers (LanceDB-backed) will consume. Hybrid dual-copy mirrors
// Phase 2 physical Stage 1 (sdk-budget) pattern.
export * from "./internal/circuit-breaker.js";

// Iter 45: second Stage 3 file move — embedding-adapter types (61 LOC,
// pure type-only file). Defines the contract that provider adapters
// (openai-embedding, ollama-embedding, etc.) implement.
// `MemoryEmbeddingProviderAdapter` + `CreateAdapterOptions` +
// `EmbeddingRuntime` + `EmbeddingRuntimeStats` + `EmbeddingCache`.
export * from "./internal/embedding/embedding-adapter.js";

// Iter 46: third Stage 3 file move — LruEmbeddingCache (36 LOC).
// Concrete bounded-LRU impl of `EmbeddingCache` from iter 45's
// embedding-adapter types. KEPT INTERNAL — not re-exported from the
// public barrel because no Stage 1 surface consumes it yet. Lives in
// sdk-memory's internal/ so future rich providers (LanceDB-backed)
// can import it as a sibling. Rollup-plugin-dts treeshake limitation
// + lack of public consumer = internal-only. Will be promoted to
// public if/when a consumer surface needs it.

// Iter 51: eighth Stage 3 file move — active-memory-cache (74 LOC).
// TTL-bounded + capacity-bounded LRU cache for `runActiveMemory`
// results. Depends only on `node:crypto` + iter 48's
// active-memory-types. `ActiveMemoryCache` class + `ActiveMemoryCacheOptions`
// interface exposed publicly — future `active-memory.ts` move targets
// this as a sibling. (No rollup-dts treeshake issue because
// `ActiveMemoryResult` is already publicly reachable via the barrel.)
export * from "./internal/active-memory/active-memory-cache.js";

// Iter 48: fifth Stage 3 file move — active-memory-types (24 LOC,
// pure type-only). Defines `ActiveMemoryQueryMode`, `ActiveMemoryStatus`,
// `ActiveMemoryResult`. Imports only `MemorySearchHit` from iter 47's
// index-manager-contract (sibling). Unblocks the upcoming
// `active-memory.ts` + `active-memory-cache.ts` moves.
export * from "./internal/active-memory/active-memory-types.js";
export * from "./internal/adapter-catalog.js";
export * from "./internal/adapter-http-error.js";
// M4-3: createCategorizedMemory — typed taxonomy store over safePathJoin +
// redactSecrets + replaceFileAtomic/withCwdMutex (per-category .md partition).
export * from "./internal/categorized-memory.js";
// Iter 59: sixteenth Stage 3 file move — dreaming-diary (74 LOC).
// Dream-diary append per ADR D7. Diary lives at
// `.theokit/memory/dream-diary.md` and grows with one entry per
// sweep. Content-hashed entry for idempotency; atomic writes via
// replaceFileAtomic (EC-3) so a crash mid-write can't leave a
// half-written diary. `appendDiaryEntry(cwd, entry)` + `diaryPath`
// + `renderDiaryEntry` + `entryHash` + `DiaryEntry` interface.
// Future `dreaming-run.ts` move (post-sweep summary writer) composes
// with this as sibling. Dependencies all resolved: persistence
// sub-path + markdown-store (iter 56).
export * from "./internal/dreaming/dreaming-diary.js";
// Iter 54: eleventh Stage 3 file move — dreaming-phases (149 LOC).
// Three-phase memory consolidation: `lightPhase` (cosine ≥ 0.95
// dedup) + `remPhase` (single-link agglomerative clustering at
// cosine ≥ 0.75) + `deepPhase` (consolidated-markdown renderer).
// Dependencies (both sibling): `EmbeddingRuntime` (iter 45) +
// `MemoryFact` (iter 52). Future `dreaming-run.ts` move composes
// with these three as sibling imports.
export * from "./internal/dreaming/dreaming-phases.js";
// Iter 60: seventeenth Stage 3 file move — dreaming-run (110 LOC).
// Dreaming sweep orchestrator per ADR D7. Composes:
//   - readFactsFromMarkdown (iter 56) — input
//   - lightPhase (iter 54)            — dedup
//   - remPhase   (iter 54)            — cluster
//   - deepPhase  (iter 54)            — consolidated-notes render
//   - appendDiaryEntry (iter 59)      — diary append
// All file writes go through `replaceFileAtomic` (EC-3); the whole
// sweep holds `withCwdMutex` so a concurrent `Remember:` append
// can't race it. `runDreamingSweep(options): Promise<DreamingResult>`
// is the public entrypoint, with DreamingOptions + DreamingResult
// shapes. Failures are swallowed with stderr warn (status: "error")
// so a single sweep crash never bubbles into the agent loop.
// CLOSES the dreaming/ cluster — 4 files (phases/diary/run + types)
// fully in sdk-memory.
export * from "./internal/dreaming/dreaming-run.js";
// theokit#128 — the four adapters sdk-core advertises that this package had drifted behind.
export * from "./internal/embedding/azure-openai-embedding.js";
export * from "./internal/embedding/cohere-embedding.js";
export * from "./internal/embedding/deepinfra-embedding.js";
export * from "./internal/embedding/gemini-embedding.js";
export * from "./internal/embedding/jina-embedding.js";
export * from "./internal/embedding/mistral-embedding.js";
export * from "./internal/embedding/ollama-embedding.js";
// Iter 73: thirtieth Stage 3 file move — openai-compatible adapter
// runtime (276 LOC) + inlined adapter-http-error mapper (160 LOC).
// `createOpenAiCompatibleRuntime(cfg, options)` is the shared factory
// the 6 provider-specific adapters (openai/mistral/deepinfra/openrouter/
// voyage; ollama uses its own native API path) compose around. EC-2:
// embeddingsPath REPLACES `/v1/embeddings` rather than concatenating
// (DeepInfra uses `/v1/openai/embeddings`). EC-4: dimensionByModel
// table is closed — unknown models throw `embedding_unknown_model`
// before any network call to prevent vec0 dimension mismatches.
// Linear-backoff retry (50ms × attempt, max 2 retries) on 429 + 5xx;
// AuthenticationError on missing API key; NetworkError on malformed
// `data: []` response. **Inlined error mapper:** sdk-core's
// `mapOpenAICompatibleError` lives in `internal/errors/mappers/` —
// not part of the public errors surface. sdk-memory carries its own
// byte-equivalent copy in `./adapter-http-error.js` so the entire
// adapter cluster ships without reaching into sdk-core internals.
// Translation table: 401/403 → AuthenticationError; 429 →
// RateLimitError; 400 → ConfigurationError; 408 → NetworkError
// timeout; 5xx → NetworkError server_error; everything else →
// UnknownAgentError. body.error.code introspection covers
// `context_too_long` / `content_filtered` / `model_unavailable` /
// `quota_exceeded` (incl. HTTP 402) per ADR D67.
export * from "./internal/embedding/openai-compatible.js";
// Iter 74: thirty-first through thirty-seventh Stage 3 file moves —
// embedding-adapter cluster close. 7 files in one logical move
// (each ~40 LOC; cluster total ~280 LOC):
//   - openai-embedding (#31)     — text-embedding-3-small default
//   - mistral-embedding (#32)    — mistral-embed
//   - deepinfra-embedding (#33)  — BGE/E5/etc; EC-2 embeddingsPath
//                                 override `/v1/openai/embeddings`
//   - voyage-embedding (#34)     — voyage-3-lite default
//   - openrouter-embedding (#35) — proxies multi-provider catalog ids
//   - ollama-embedding (#36)     — only `transport: "local"`; sentinel
//                                 `ollama-local` apiKey for no-auth
//   - adapter-catalog (#37)      — `MEMORY_EMBEDDING_ADAPTERS` Record
//                                 indexed by provider id (ADR D11/D183)
// All 6 provider adapters delegate to iter 73's
// createOpenAiCompatibleRuntime. CLOSES the embedding-adapter cluster:
// types (iter 45) + cache (iter 46) + shared factory + inlined error
// mapper (iter 73) + 6 providers + catalog (this iter) all canonical
// in @theokit/sdk-memory.
export * from "./internal/embedding/openai-embedding.js";
export * from "./internal/embedding/openrouter-embedding.js";
export * from "./internal/embedding/voyage-embedding.js";
// Iter 65: twenty-second Stage 3 file move — index-db (109 LOC).
// Thin wrapper around the SQLite driver. Prefers `node:sqlite` on
// Node 22.5+; falls back to `better-sqlite3`. Applies WAL with
// NFS/SMB/FUSE fallback (ADR D63) BEFORE schema setup. Corrupt-DB
// recovery (EC-7): on "malformed" / "not a database" / "encrypted"
// errors, the file (+ WAL + SHM siblings) is renamed aside to
// `<path>.corrupt-<ts>` and the schema is rebuilt from scratch.
// `openMemoryDb(opts)` + `defaultIndexPath(cwd)` +
// `MemoryDb` / `OpenDbOptions` interfaces. Dependencies all resolved:
// `@theokit/sdk/errors` (ConfigurationError public),
// `@theokit/sdk/persistence` (applyWalWithFallback),
// sibling `./index-schema.js` (PRAGMA + SCHEMA from iter 49).
// Unblocks future moves: `sqlite-vec-loader`, `vec-index`,
// `index-manager`, `migrate-sqlite-to-lance`.
export * from "./internal/index/index-db.js";
// Iter 72: twenty-ninth Stage 3 file move — index-manager (446 LOC).
// THE big orchestrator. `IndexManager` class implements MemoryIndex
// over a SQLite + sqlite-vec hybrid backend. Overloaded `open()`
// dispatches to Lance via iter 70's openLanceIndex when
// `backend: "lance"`; default sqlite-vec path uses iter 65's
// openMemoryDb + iter 66's loadSqliteVecExtension + iter 67's
// vec-index helpers. EC-1 identity invalidation: dimension/model/
// provider changes drop the embeddings table BEFORE re-creating it
// so the next sync re-embeds. `sync()` walks MEMORY.md + notes/
// + wiki/ + sessions/ markdown corpus via iter 56/57/62's loaders,
// chunks via iter 53's chunkMarkdown, batch-embeds missing chunks.
// `search()` runs hybrid retrieval: FTS5 BM25 via iter's
// sanitizeFts5Query + sqlite-vec KNN, merges by chunkId, blends
// scores via configurable weights (vectorWeight 0.6 + textWeight
// 0.4 default), filters by minScore + sources, sorts by combined
// score. **CLOSES the index/ cluster** in sdk-memory.
export * from "./internal/index/index-manager.js";
// Iter 47: fourth Stage 3 file move — index-manager-contract types
// (75 LOC, pure type-only). Defines `MemorySearchHit`, `IndexStatus`,
// `SearchOptions`, `MemoryBackend`, `OpenIndexOptions` — the contract
// every IndexManager impl (sqlite-vec, lance, future ANN backends)
// satisfies. Imports only `EmbeddingRuntime` from iter 45's
// embedding-adapter.
export * from "./internal/index/index-manager-contract.js";
// Iter 70: twenty-seventh Stage 3 file move — index-manager-dispatch (50 LOC).
// Dispatch helpers used by `IndexManager.open` to route between
// sqlite-vec (default) and lance backends without bloating the
// composed `index-manager.ts` past the G8 400-LoC budget. Exports
// `VALID_BACKENDS` (`["sqlite-vec", "lance"]`), `assertValidBackend`
// runtime guard (EC-1 — `invalid_memory_backend` typed error on
// any non-canonical literal), and `openLanceIndex(opts)` async
// factory (throws `lance_requires_embedding` when embedding runtime
// missing because Lance is vector-only — no FTS fallback).
// Future `index-manager.ts` move composes with this as sibling.
export * from "./internal/index/index-manager-dispatch.js";
// Iter 49: sixth Stage 3 file move — index-schema (61 LOC, zero
// imports). Defines `SCHEMA_STATEMENTS` + `PRAGMA_STATEMENTS` SQL
// constants for the SQLite memory index. Unblocks future `index-db`
// + `index-manager` + `vec-index` moves which depend on schema DDL.
export * from "./internal/index/index-schema.js";
// Iter 68: twenty-fifth Stage 3 file move — lance-index (273 LOC).
// LanceDB-backed alternative memory index per ADR D43 — opt-in via
// `Memory.create({ index: { backend: "lance" } })`; SQLite remains
// default. `@lancedb/lancedb` dynamically required via createRequire
// with EC `lance_backend_unavailable` typed error on missing peer.
// EC-1: search filters use Lance's SQL string predicate with `'`→`''`
// escape (bind parameters not supported by Lance 0.30). EC-8:
// embedding dimension validated against on-disk Arrow FixedSizeList
// `listSize` (forward-compat `fixedSize` fallback). Exports:
// LanceIndex class (open/addFacts/search/countFacts/removeFacts/close)
// + LanceFactRecord + OpenLanceOptions + LanceSearchOptions +
// LanceSearchHit + isLanceAvailable + lanceStoragePath helpers.
export * from "./internal/index/lance-index.js";
// Iter 69: twenty-sixth Stage 3 file move — lance-memory-adapter (131 LOC).
// `LanceMemoryAdapter` wraps `LanceIndex` (iter 68) to expose the
// `MemoryIndex` contract (iter 50). Drop-in replacement for the
// SQLite IndexManager when consumers select `backend: "lance"`.
// `sync()` is no-op (returns frozen empty SyncResult); `search()`
// uses vector-only (textScore=0, vectorScore=score, 200-char
// snippet truncation; namespace defaults to "default" pending
// v1.5 SearchOptions.namespace surface); `status()` reports
// `backend: "hybrid"` with zero counts (consumers needing exact
// row count call `unwrap().countFacts()` directly). `unwrap()`
// returns the inner LanceIndex for advanced callers (migration
// tool, benchmark script). Future `index-manager-dispatch.ts` move
// composes with this as sibling.
export * from "./internal/index/lance-memory-adapter.js";
// Iter 50: seventh Stage 3 file move — memory-index (67 LOC).
// Defines `MemoryIndex` interface (the OCP-preserving 4-method
// contract — `sync`/`search`/`status`/`close` — both sqlite-vec and
// lance backends satisfy) + `SyncResult` + `parseSearchOptions`
// helper. Re-exports `IndexStatus`, `MemorySearchHit`, `SearchOptions`
// from iter 47's index-manager-contract for stable internal import
// paths. **Side-effect:** the public re-export of `MemorySearchHit`
// here unblocks the rollup-plugin-dts treeshake limitation that
// forced the iter 48 inline-duplicate workaround — that mirror is
// dropped in this same iter (see internal/active-memory-types.ts).
export * from "./internal/index/memory-index.js";
// Iter 71: twenty-eighth Stage 3 file move — migrate-sqlite-to-lance (249 LOC).
// One-shot SQLite → LanceDB migration per ADR D44. Reads all facts
// from the SQLite chunks table, writes them to a `lance-new/`
// staging directory, validates count + sample-compare (up to 10
// facts) with NFC unicode normalization (EC-3 MUST FIX — SQLite and
// Lance native bindings can normalize differently), then atomically
// renames the staging dir to final `lance/`. Dry-run discards
// staging without committing. Failed validation leaves SQLite
// intact + removes staging. T1.4 secret redaction (ADR D68/D70):
// the user-supplied or default logger is wrapped so fact text
// containing keys is masked BEFORE reaching destination — bypass
// via custom logger is impossible by design. Placeholder embedder
// (deterministic 8-dim hash) is sufficient for migration validation;
// consumers re-embed on first real query post-migration.
// Dependencies all resolved sibling: index-db (iter 65) + lance-index
// (iter 68) + memory-types (iter 52).
export * from "./internal/index/migrate-sqlite-to-lance.js";
// Iter 63: twentieth Stage 3 file move — migration (90 LOC).
// One-shot legacy-JSON → MEMORY.md migration per ADR D8.
// `migrateLegacyJson(cwd, config)` triggers when the per-namespace
// `<scope>-<userId>.json` exists AND `MEMORY.md` does not; reads
// JSON facts, appends each as a `## Facts` bullet via iter 56's
// `appendFactToMarkdown`, then unlinks the JSON file. Idempotent —
// per-process `Set<string>` (cwd::namespace::scope::userId key)
// guards re-entry. Failure modes typed in `MigrationResult.reason`:
// "already-migrated" / "no-legacy-json" / "markdown-exists" /
// "readonly-fs". `resetMigrationStateForTests` exposed for test
// isolation. Dependencies sibling: markdown-store (iter 56) +
// memory-types (iter 52). NOTE: per-package flag map (Set) — this
// is documented in source.
export * from "./internal/index/migration.js";
// Iter 66: twenty-third Stage 3 file move — sqlite-vec-loader (38 LOC).
// Loads the `sqlite-vec` extension into an opened MemoryDb. Wraps the
// native `load(db)` call with a typed error path (EC-8) so callers
// see a `sqlite_vec_unavailable` ConfigurationError instead of a raw
// native error. `loadSqliteVecExtension(db)` + `isSqliteVecLoaded(db)`
// (tiny `SELECT vec_version()` probe). Dependencies sibling: iter 65's
// MemoryDb. Future `vec-index.ts` move composes with this as sibling.
export * from "./internal/index/sqlite-vec-loader.js";
// Iter 67: twenty-fourth Stage 3 file move — vec-index (127 LOC).
// Vector index helpers per ADR D2 + D4. Embeddings live in a
// `embeddings(chunk_id, vec)` vec0 virtual table provided by
// sqlite-vec. Embedding identity (providerId+model+dimension) lives
// in `meta` table — mismatches force a full re-embed sweep (EC-1).
// Exports: META_KEY_* constants + EmbeddingIdentity +
// read/writeEmbeddingIdentity + identityMatches + dropVectorIndex +
// createVectorIndex + packVector (Float32Array → Buffer for
// sqlite-vec BLOB binding) + upsertEmbedding (DELETE+INSERT with
// BigInt id binding per vec0 v0.1.9 contract) + vectorSearch (KNN
// MATCH+k syntax) + EmbedAllArgs + embedMissingChunks (LEFT JOIN
// embeddings query → batch embed → upsert). Dependencies sibling:
// EmbeddingRuntime (iter 45) + MemoryDb (iter 65).
export * from "./internal/index/vec-index.js";
// Iter 52: ninth Stage 3 file move — memory-types (113 LOC).
// Public memory shape types: `MemoryConfig`, `MemoryFact`,
// `MemoryChunk`, `MemoryReadResult`, `MemoryFileEntry`, +
// `legacyMemoryJsonPath` helper for pre-ADR-D8 JSON path resolution,
// + canonical `redactSecrets` re-export from `@theokit/sdk` (ADR D68).
// Cross-package imports go through public sub-paths only —
// `@theokit/sdk/path-safety` (`safePathJoin` + iter 52-promoted
// `sanitizeIdentifier`) + `@theokit/sdk` (`redactSecrets`). Future
// `storage/*`, `migration`, `chunk-markdown` moves target this as
// sibling without re-importing from sdk-core.
export * from "./internal/memory-types.js";
// Iter 53: tenth Stage 3 file move — chunk-markdown (141 LOC).
// `chunkMarkdown(text, options?): MemoryChunk[]` algorithm mirrors
// peer-project's memory-host-sdk implementation per ADR D1 of the
// memory-system-peer-project-parity plan. Heading + blank-line aware,
// word-boundary aligned for oversized paragraphs (EC-6 enforced).
// Depends only on `node:crypto` + iter 52's MemoryChunk type
// (sibling import via ./memory-types.js).
export * from "./internal/store/chunk-markdown.js";
// Iter 56: thirteenth Stage 3 file move — markdown-store (134 LOC).
// Markdown-first memory storage primitives per ADR D1 of the
// memory-system-peer-project-parity plan. Public path helpers
// (`memoryDir`, `memoryMdPath`, `notesDir`), fact reader+writer
// (`readFacts`, `appendFact`, `readFactsFromMarkdown`,
// `appendFactToMarkdown`), and notes lister (`listNotes`). All writes
// go through `replaceFileAtomic` + per-cwd mutex (EC-4) via the
// public `@theokit/sdk/persistence` sub-path.
// Configuration-aware accessors honor MemoryConfig.enabled gate.
// Future `tools.ts`, `dreaming-diary`, `dreaming-run`,
// `session-loader`, `session-summary-writer`, `transcript-store`,
// `wiki-loader`, `migration` moves all compose with this as sibling.
export * from "./internal/store/markdown-store.js";
// Iter 55: twelfth Stage 3 file move — reader (57 LOC).
// `readMemoryFileBounded(opts): Promise<MemoryReadResult>` — the
// bounded read with truncation info that powers ADR D5's
// `memory_get` tool. Mirrors peer-project's `buildMemoryReadResult`
// semantics (1-indexed `from`, default 200 lines, truncated=true
// when content remains past the slice). Default lines constant
// `DEFAULT_MEMORY_READ_LINES` also exported. Depends only on
// `node:fs/promises` + `node:path` + iter 52's `MemoryReadResult`
// (sibling import via ./memory-types.js).
export * from "./internal/store/reader.js";
// Iter 62: nineteenth Stage 3 file move — session-loader (45 LOC).
// Session summary discovery per ADR D20. Mirrors iter 57's
// `wiki-loader` shape: scans `.theokit/memory/sessions/*.md` and
// emits `{absolutePath, relPath}` records that future indexer moves
// tag with `source="sessions"` for `memory_search { corpus: "sessions" }`
// filter. `discoverSessionFiles` + `SessionFile`. CLOSES the
// sessions/ cluster in sdk-memory (writer iter 61 + loader this iter).
// Dependencies all sibling: `memoryDir` from markdown-store (iter 56)
// + `sessionsDir` from session-summary-writer (iter 61).
export * from "./internal/store/session-loader.js";
// Iter 61: eighteenth Stage 3 file move — session-summary-writer (88 LOC).
// Per-run session summary writer per ADR D20. After every finished
// run, writes a markdown summary to
// `.theokit/memory/sessions/<runId>.md`. EC-9: only `status === "finished"`
// runs trigger a write — cancelled/errored runs would otherwise pollute
// the recall corpus with partial transcripts. Both user and assistant
// text run through redactSecrets (ADR D68) + char-truncate at 2000
// before persist. runId sanitized to `[a-zA-Z0-9_-]` so a malicious
// id cannot escape the sessions directory. Future indexer moves tag
// these with `source="sessions"` for memory_search corpus filter.
// `writeSessionSummary` + `sessionsDir` + `sessionSummaryPath` +
// `SessionSummaryInput`.
export * from "./internal/store/session-summary-writer.js";
// Iter 58: fifteenth Stage 3 file move — transcript-store (48 LOC).
// Optional on-disk persistence for Active Memory recall transcripts
// per ADR D6. `persistActiveMemoryTranscript(cwd, transcript)` writes
// one JSON file per run under
// `.theokit/memory/transcripts/active-memory/<runId>.json` via
// atomicWriteJson (no torn writes during crash). Failures are
// swallowed with a stderr warning so transcript IO never crashes the
// agent run. ActiveMemoryTranscript shape exported for consumer
// typing. Future `active-memory.ts` move composes with this as
// sibling. Dependency chain (both resolved): persistence sub-path +
// `./markdown-store.js` (iter 56).
export * from "./internal/store/transcript-store.js";
// Iter 57: fourteenth Stage 3 file move — wiki-loader (50 LOC).
// Read-only wiki supplement discovery (ADR Phase 10 of
// memory-system-peer-project-parity). Lists `.theokit/memory/wiki/*.md`
// and emits `{absolutePath, relPath}` records that future indexer
// moves (`index-db`/`index-manager`) consume with `source="wiki"`
// chunk tagging so `memory_search { corpus: "wiki" }` filter scopes
// hits. Depends on sibling `./markdown-store.js` for `memoryDir`
// (moved iter 56).
export * from "./internal/store/wiki-loader.js";
// Iter 64: twenty-first Stage 3 file move — tools (176 LOC).
// LLM-facing memory tools (`memory_search` + `memory_get`) per ADR D5.
// Mirrors peer-project's tool surface. Each tool exposes
// `{ name, description, inputSchema (JSON Schema), execute }`.
// `createMemorySearchTool({ index, maxTotalChars? })` accepts an
// already-opened MemoryIndex (from iter 50's contract). EC-10:
// snippet+citation overhead capped at maxTotalChars (default
// 16384) so a misbehaved index can't blow the JSON response.
// `createMemoryGetTool({ cwd })` reads bounded excerpts via iter
// 55's `readMemoryFileBounded`; EC-2: resolved paths that escape
// memoryDir get rejected with typed ConfigurationError. Cross-package
// imports: `@theokit/sdk/errors` for ConfigurationError. All other
// imports sibling: index-manager-contract / memory-index / markdown-store
// / reader.
export * from "./internal/tools.js";
