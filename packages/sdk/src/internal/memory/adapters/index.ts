/**
 * theokit#160 — the ONE embedding runtime, shared with `@theokit/sdk-memory`.
 *
 * The satellite used to carry a full copy of `createOpenAiCompatibleRuntime`, and the peer's catalog
 * REPLACES core's at runtime when installed — so the copy that ran was not the copy most people
 * read. That duplication produced theokit#128 (four adapters present in one copy, missing from the
 * other, for two months), and every fix since had to be applied twice by hand: the `{model}` path
 * substitution, then all three provider dialects.
 *
 * This is the shared leaf both packages now import. Semver-exempt, exactly like the
 * `internal/persistence` and `internal/security` sub-paths that exist for the same reason: extracted
 * packages need primitives that are not part of the stable public contract.
 *
 * Semver-exempt: NOT part of the stable `@theokit/sdk` API. The sub-path IS declared in
 * `package.json` `exports`, so the names below must survive into the published declarations.
 */

// NOTE: the adapter/runtime TYPES are deliberately NOT re-exported here. `embedding-adapter.ts`
// carries the tag that `tsconfig.base.json`'s `stripInternal: true` acts on, so tsc elides a pure
// `export type` of them from the emitted `.d.ts` — the re-export would compile and then vanish,
// which is worse than not offering it. `@theokit/sdk-memory` keeps its own structurally-identical
// copy in `internal/embedding/embedding-adapter.ts` and annotates against that.
//
// The same mechanism is why no comment attached to the statement below may name that tag: a
// leading comment range is scanned as TEXT, so merely mentioning it here would delete the exports.
export { globalEmbeddingCache, LruEmbeddingCache } from "../embedding-cache.js";
export {
  createOpenAiCompatibleRuntime,
  type EmbeddingDialect,
  type OpenAiCompatibleConfig,
} from "./openai-compatible.js";
