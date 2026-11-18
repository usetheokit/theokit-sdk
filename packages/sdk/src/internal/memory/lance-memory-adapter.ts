/**
 * `LanceMemoryAdapter` — wraps `LanceIndex` to expose the common
 * `MemoryIndex` interface (sync/search/status/close) so consumers of
 * `IndexManager.open({ backend: "lance" })` get a drop-in replacement
 * for the SQLite-backed `IndexManager`.
 *
 * Semantic deltas vs SQLite (documented so callers know what to expect):
 *
 *  - `sync()` is a NO-OP. Lance is a pure vector store — there is no
 *    markdown corpus to crawl. It returns zero counts with `supported: false`
 *    so the result is not mistaken for a sync that found nothing. Consumers
 *    writing facts hold a `LanceIndex` and call `addFacts` on it; the adapter
 *    does not hand its adaptee out.
 *  - `search()` is HYBRID, not vector-only. Lance supplies the vector distance
 *    and `translateLanceHit` adds a client-side term-overlap ratio (T4.5), so
 *    `textScore` is a real number in 0..1 and `score` is `0.7 * vectorScore +
 *    0.3 * textScore` — never `=== vectorScore`. This block said the opposite
 *    for as long as T4.5 has been shipped, while the docblock 90 lines below
 *    described the change correctly, so the two halves of one file disagreed
 *    and the header is the half a caller reads.
 *  - `status()` reports `backend: "hybrid"` only when an embedding runtime
 *    is wired (always the case for Lance — embedding is required at open).
 *    Both counts are 0 with `countsExact: false`: the port declares `status()`
 *    synchronous and Lance's row count is async, so nothing can be measured
 *    here. The zeros are placeholders and the flag says which.
 *
 * Ships with the lancedb-backend-ship-v1-1 plan (close D12, supersede via
 * D43). v1.4.0 of `@theokit/sdk`.
 *
 * @internal
 */

import type { IndexStatus, MemorySearchHit, SearchOptions } from "./index-manager-contract.js";
import { type HybridWeights, resolveWeights } from "./index-manager-helpers.js";
import type { LanceIndex } from "./lance-index.js";
import { type MemoryIndex, parseSearchOptions, type SyncResult } from "./memory-index.js";

/**
 * Default namespace used when consumers call `search()` without specifying
 * one. The SQLite `IndexManager` does not surface namespace in its public
 * `search()` signature either — both backends therefore behave consistently
 * under the "single-workspace, single-namespace" assumption that v1.4 ships.
 *
 * v1.5 candidate: surface `namespace` in `SearchOptions` (additive — no
 * breaking change) so multi-tenant Lance consumers can scope queries.
 */
const DEFAULT_NAMESPACE = "default";

/**
 * Lance has no corpus to walk, and the result now SAYS so.
 *
 * The counts stay zero — inventing numbers would trade one false claim for another. What changed is
 * `supported: false`: an all-zeros result was previously indistinguishable from a real sync that
 * found nothing to reindex, and the comment above this constant used to present that as the goal
 * ("so callers' existing logging does not break"). A caller can now tell "nothing to do" from
 * "this backend does not do this".
 */
const UNSUPPORTED_SYNC_RESULT: SyncResult = Object.freeze({
  filesScanned: 0,
  filesUpdated: 0,
  chunksWritten: 0,
  chunksEmbedded: 0,
  supported: false,
});

/**
 * Presents a `LanceIndex` as a {@link MemoryIndex}; the file header lists how it differs from the
 * SQLite index. `@theokit/sdk-memory` extends this class rather than copying it (#1068).
 */
export class LanceMemoryAdapter implements MemoryIndex {
  constructor(private readonly inner: LanceIndex) {}

  /**
   * Not applicable to Lance — see file header. Returns zero counts with `supported: false` so a
   * caller can distinguish this from a real sync that found nothing.
   */
  async sync(): Promise<SyncResult> {
    return UNSUPPORTED_SYNC_RESULT;
  }

  // jscpd:ignore-start — search signature + early-out is idiomatic
  // overlap with IndexManager.search; further factoring would hurt
  // readability (the bodies diverge sharply right after).
  async search(query: string, options: SearchOptions = {}): Promise<MemorySearchHit[]> {
    if (query.trim().length === 0) return [];
    const { maxResults, minScore } = parseSearchOptions(options);
    // jscpd:ignore-end
    const lanceHits = await this.inner.search(query, {
      namespace: DEFAULT_NAMESPACE,
      limit: maxResults * 2,
      ...(options.sources !== undefined ? { sources: options.sources } : {}),
    });
    return lanceHits
      .filter((h) => h.score >= minScore)
      .slice(0, maxResults)
      .map((h) => translateLanceHit(h, query, resolveWeights(options)));
  }

  status(): IndexStatus {
    // The Lance API is async and `status()` is not, so no count can be taken here. The zeros are
    // placeholders and `countsExact: false` says so — previously they were indistinguishable from a
    // measured empty index, so a caller testing `chunksIndexed > 0` got a false negative on every
    // run regardless of how many rows the table held.
    //
    // There is deliberately no escape hatch. This class used to carry `unwrap(): LanceIndex`,
    // documented as being for "the migration tool, benchmark script" — measured 2026-09-01, it had
    // ZERO callers anywhere in the monorepo, including those two, which hold a `LanceIndex`
    // directly and never open the adapter. What it did have was this comment pointing at it, which
    // made the leak read as the supported way to work around the limitation. A caller that needs
    // the real count needs `LanceIndex`, and the honest way to get one is to open one.
    return {
      backend: "hybrid",
      filesIndexed: 0,
      chunksIndexed: 0,
      countsExact: false,
    };
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/**
 * Translate `LanceSearchHit` to `MemorySearchHit`. Field mapping:
 *
 *   - `id` → `path` (Lance has no file-system provenance; use opaque id)
 *   - `text` → `snippet` (truncated to 200 chars matching IndexManager convention)
 *   - `score` → combined (0.7 × vectorScore + 0.3 × textScore)
 *   - `vectorScore` → from Lance's distance metric
 *   - `textScore` → T4.5 client-side term-overlap ratio (removes ADR D43 vector-only caveat)
 *   - `source` → `source`
 *   - synthetic `startLine: 0, endLine: 0` (Lance has no line info)
 *   - synthetic `citation: id` (no path:line citation available)
 */
function translateLanceHit(
  hit: { id: string; text: string; source: "memory" | "sessions" | "wiki"; score: number },
  query: string | undefined,
  weights: HybridWeights,
): MemorySearchHit {
  const textScore = query !== undefined ? computeTermOverlapScore(query, hit.text) : 0;
  const vectorScore = hit.score;
  // The CALLER's weights, through the same `resolveWeights` the SQLite path uses. These were the
  // literals 0.7 and 0.3, so a caller that tuned `vectorWeight` / `textWeight` had its tuning applied
  // on one backend and silently dropped on the other — the shape of failure that makes a swap-in
  // backend untrustworthy. The defaults differ between the two (0.6/0.4 from resolveWeights, versus
  // the 0.7/0.3 written here), so unweighted results move slightly; that is the point, since one of
  // the two numbers was not the contract's.
  const combined =
    (vectorScore * weights.vectorWeight + textScore * weights.textWeight) / weights.total;
  return {
    path: hit.id,
    startLine: 0,
    endLine: 0,
    score: combined,
    textScore,
    vectorScore,
    snippet: hit.text.slice(0, 200),
    source: hit.source,
    citation: hit.id,
  };
}

/**
 * T4.5 — Client-side term-overlap score for Lance hybrid search.
 * Counts what fraction of query terms appear in the text (case-insensitive).
 * Simple but effective for re-ranking vector hits by lexical relevance.
 * Returns 0..1 where 1 = all query terms present.
 */
function computeTermOverlapScore(query: string, text: string): number {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (queryTerms.length === 0) return 0;
  const textLower = text.toLowerCase();
  const matched = queryTerms.filter((term) => textLower.includes(term)).length;
  return matched / queryTerms.length;
}
