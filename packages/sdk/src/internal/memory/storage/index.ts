/**
 * #430 — the ONE markdown memory store, shared with `@theokit/sdk-memory`.
 *
 * The satellite carried a full copy, and `Memory.runDreamingSweep` REPLACES this one with the
 * peer's whenever the peer is installed — so the copy that ran was not the copy most people read.
 * The copy stayed on the pre-#389 layout (bullets under `MEMORY.md ## Facts`) while this one moved
 * to a file per memory, which meant installing `@theokit/sdk-memory` made every memory the SDK had
 * written unreadable. It reported `factsBefore: 0`, indistinguishable from an empty store.
 *
 * This is the same defect theokit#160 fixed for the embedding runtime, in the same package pair,
 * with the same remedy: one implementation, imported by both. A second copy is a second place for
 * the layout to drift, and the drift is silent by construction — nothing fails, facts just stop
 * being found.
 *
 * Semver-exempt: NOT part of the stable `@theokit/sdk` API. The sub-path IS declared in
 * `package.json` `exports`, so the names below must survive into the published declarations.
 */

// #1065 — leaf modules the satellite used to copy (schema, database opener, vector index, chunker,
// bounded reader, active-memory cache and types). None holds module-level state, so a re-export
// does not merge two runtime states. `defaultIndexPath` is exported above.
export {
  ActiveMemoryCache,
  type ActiveMemoryCacheOptions,
  type TenantContext,
} from "../active-memory-cache.js";
export type {
  ActiveMemoryQueryMode,
  ActiveMemoryResult,
  ActiveMemoryStatus,
} from "../active-memory-types.js";
// The whole diary module, not just its path: 39 lines across three functions, zero diverging.
export {
  appendDiaryEntry,
  type DiaryEntry,
  diaryPath,
  entryHash,
  renderDiaryEntry,
} from "../dreaming/diary.js";
// The sweep itself (B-444): phases and orchestrator were a second copy in the satellite, and the
// copy had already drifted (it lacked the protected-kind dedup policy and `memoryRoot`).
export {
  type Cluster,
  type ClusterResult,
  type DedupResult,
  deepPhase,
  lightPhase,
  remPhase,
} from "../dreaming/phases.js";
export {
  type DreamingOptions,
  type DreamingResult,
  runDreamingSweep,
} from "../dreaming/run.js";
// Path helpers the satellite also needs. Each was a copy on both sides, and each is a pure function
// over the memory root — the cheapest possible thing to share and the least excusable to duplicate.
export { defaultIndexPath, type MemoryDb, type OpenDbOptions, openMemoryDb } from "../index-db.js";
// The corpus walk, shared for the reason the cluster above is. The satellite's copy had drifted
// further than the others: it walked `notes/`, `wiki/` and `sessions/` and never picked up the
// per-memory files at the root — the layout #389 converged on — so installing that package made
// every converged memory unsearchable while reporting no error at all.
export { collectMarkdownFiles, type DiscoveredFile } from "../index-manager-helpers.js";
export { PRAGMA_STATEMENTS, SCHEMA_STATEMENTS } from "../index-schema.js";
export { lanceStoragePath } from "../lance-index.js";
// The SQLite fact reader the Lance migration uses. 26 lines, zero diverging between the packages.
export { readAllSqliteFacts, type SqliteFactRow } from "../migrate-sqlite-to-lance.js";
export { loadSqliteVecExtension } from "../sqlite-vec-loader.js";
export {
  createVectorIndex,
  dropVectorIndex,
  type EmbedAllArgs,
  type EmbeddingIdentity,
  embedMissingChunks,
  identityMatches,
  META_KEY_DIMENSION,
  META_KEY_MODEL,
  META_KEY_PROVIDER_ID,
  packVector,
  readEmbeddingIdentity,
  upsertEmbedding,
  type VectorHitRow,
  vectorSearch,
  writeEmbeddingIdentity,
} from "../vec-index.js";
export { type ChunkMarkdownOptions, chunkMarkdown } from "./chunk-markdown.js";
// The declared fact ceiling (B-380): one validator and one refusal for both write families, so
// the markdown store and the satellite's in-memory provider refuse with the same words.
export { ceilingReachedError, resolveMaxFacts } from "./fact-ceiling.js";
export {
  appendFact,
  appendFactToMarkdown,
  memoryMdPath,
  notesDir,
  readFacts,
  readFactsFromMarkdown,
} from "./markdown-store.js";
// Root resolution moved out of the store and into one module (#463). `memoryDir` and
// `memoryWriteDir` are gone: the first was one of fourteen places that answered "where does memory
// live?", and the second was the only one that answered differently.
export {
  asMemoryRoot,
  claudeProjectMemoryDir,
  indexBudgetWarning,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  type MemoryLocationConfig,
  type MemoryRoot,
  memoryIndexRoot,
  memoryReadRoots,
  projectMemoryDir,
  resolveMemoryRoot,
} from "./memory-root.js";
export {
  DEFAULT_MEMORY_READ_LINES,
  type ReadFileOptions,
  readMemoryFileBounded,
} from "./reader.js";
export { discoverSessionFiles, type SessionFile } from "./session-loader.js";
// The session/wiki/transcript cluster, shared for the reason `markdown-store` is (#430): the
// satellite carried byte-identical copies, and `Memory.runDreamingSweep` swaps this implementation
// for the peer's whenever the peer is installed — so the copy that RAN was not the copy anyone had
// updated. One implementation, imported by both, is the remedy theokit#160 applied to the embedding
// runtime in the same package pair.
//
// Sharing them cost their internal-visibility tags, and the cost has a sharp edge: `stripInternal`
// matches that tag as TEXT anywhere in the comment leading an export — backticks and negation do
// not help. Writing the tag's name here, to explain its absence, deleted the export below it.
// Measured three times while landing #463; do not name it in this file.
export {
  type SessionSummaryInput,
  sessionSummaryPath,
  sessionsDir,
  writeSessionSummary,
} from "./session-summary-writer.js";
export { type ActiveMemoryTranscript, persistActiveMemoryTranscript } from "./transcript-store.js";
export { discoverWikiFiles, type WikiFile, wikiDir } from "./wiki-loader.js";
