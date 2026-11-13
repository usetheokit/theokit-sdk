/**
 * sdk-memory `lance-memory-adapter` unit test (iter 69).
 *
 * Validates the iter 69 hybrid copy of
 * `internal/memory/lance-memory-adapter.ts` from sdk-core.
 * sdk-memory now ships the canonical drop-in MemoryIndex
 * implementation backed by LanceIndex.
 *
 * sdk-core retains its copy for v1.x Lance back-compat.
 * Both copies byte-equivalent at runtime (same empty SyncResult,
 * same DEFAULT_NAMESPACE="default", same `limit: maxResults*2`
 * overfetch for minScore filter headroom, same LanceSearchHit →
 * MemorySearchHit translation: path=id / startLine=0 / endLine=0 /
 * vectorScore=score / textScore=0 / snippet=text.slice(0,200) /
 * citation=id).
 *
 * Since #1068 there is one copy: this package's `LanceMemoryAdapter`
 * extends the SDK's and adds only `unwrap()`. Two expectations below
 * moved with it and say so where they changed: `sync()` reports
 * `supported: false`, and `score` is the SDK's weighted blend rather
 * than the bare vector score.
 *
 * Uses a stub LanceIndex (no @lancedb/lancedb peer needed) so the
 * adapter math is verifiable without spinning up real LanceDB.
 */

import { LanceMemoryAdapter, type MemorySearchHit, type SyncResult } from "@theokit/sdk-memory";
import { describe, expect, it } from "vitest";

/** Stub a LanceIndex with pre-canned hits + a closed flag. */
function stubLanceIndex(
  hits: ReadonlyArray<{
    id: string;
    text: string;
    source: "memory" | "sessions" | "wiki";
    score: number;
  }>,
  captureLastSearch?: (query: string, opts: unknown) => void,
) {
  let closed = false;
  return {
    async addFacts() {
      /* no-op for adapter tests */
    },
    async search(
      query: string,
      opts: { namespace: string; limit?: number; sources?: ReadonlyArray<string> },
    ) {
      captureLastSearch?.(query, opts);
      return [...hits];
    },
    async countFacts() {
      return hits.length;
    },
    async removeFacts() {
      /* no-op */
    },
    async close() {
      closed = true;
    },
    __isClosed: () => closed,
  };
}

describe("sdk-memory lance-memory-adapter (iter 69)", () => {
  describe("sync — no-op contract", () => {
    it("test_sync_returns_frozen_empty_SyncResult", async () => {
      const stub = stubLanceIndex([]);
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      const result: SyncResult = await adapter.sync();
      // `supported: false` is new here (#1068): the adapter is the SDK's now, and the SDK's says
      // that it walked nothing, where the copy this package carried returned bare zeros that read
      // like a sync over an empty corpus.
      expect(result).toEqual({
        filesScanned: 0,
        filesUpdated: 0,
        chunksWritten: 0,
        chunksEmbedded: 0,
        supported: false,
      });
      // Object.freeze pin — mutation attempts throw in strict mode (vitest
      // tsconfig enables it) OR silently no-op. Either way the next read
      // must see the same shape.
      const result2 = await adapter.sync();
      expect(result2).toEqual(result);
    });
  });

  describe("search", () => {
    it("test_search_empty_query_returns_empty_immediately", async () => {
      let lanceCalled = false;
      const stub = stubLanceIndex([{ id: "x", text: "x", source: "memory", score: 0.9 }], () => {
        lanceCalled = true;
      });
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      const result = await adapter.search("");
      expect(result).toEqual([]);
      // Whitespace-only also short-circuits before hitting Lance.
      const result2 = await adapter.search("   \t  ");
      expect(result2).toEqual([]);
      expect(lanceCalled).toBe(false);
    });

    it("test_search_uses_DEFAULT_NAMESPACE_and_overfetches_2x", async () => {
      let captured: { query: string; opts: { namespace: string; limit?: number } } | undefined;
      const stub = stubLanceIndex(
        [{ id: "a", text: "alpha", source: "memory", score: 0.9 }],
        (q, o) => {
          captured = { query: q, opts: o as { namespace: string; limit?: number } };
        },
      );
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      await adapter.search("any query", { maxResults: 5 });
      expect(captured?.opts.namespace).toBe("default");
      // overfetch headroom for minScore filter — maxResults * 2.
      expect(captured?.opts.limit).toBe(10);
    });

    it("test_search_filters_by_minScore_then_caps_to_maxResults", async () => {
      const stub = stubLanceIndex([
        { id: "a", text: "alpha", source: "memory", score: 0.9 },
        { id: "b", text: "beta", source: "memory", score: 0.5 },
        { id: "c", text: "gamma", source: "memory", score: 0.4 },
        { id: "d", text: "delta", source: "memory", score: 0.3 },
        { id: "e", text: "epsilon", source: "memory", score: 0.1 },
      ]);
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      const result = await adapter.search("q", { maxResults: 2, minScore: 0.4 });
      // a, b, c pass minScore. cap to 2 → a + b.
      expect(result.map((h) => h.path)).toEqual(["a", "b"]);
    });

    it("test_search_translates_lance_hit_to_MemorySearchHit_shape", async () => {
      const stub = stubLanceIndex([
        { id: "id-1", text: "a".repeat(300), source: "wiki", score: 0.77 },
      ]);
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      const [hit]: MemorySearchHit[] = await adapter.search("q");
      expect(hit?.path).toBe("id-1");
      expect(hit?.startLine).toBe(0);
      expect(hit?.endLine).toBe(0);
      // `score` was asserted equal to the vector score, 0.77: the copy this package carried was
      // vector-only. The adapter is the SDK's now (#1068), which blends the vector score with a
      // term-overlap text score through `vectorWeight` / `textWeight` (0.6 / 0.4 by default). The
      // query "q" has no term longer than one character, so the text half is 0: 0.6 * 0.77.
      expect(hit?.score).toBeCloseTo(0.462, 5);
      expect(hit?.textScore).toBe(0);
      expect(hit?.vectorScore).toBeCloseTo(0.77, 5);
      // 200-char snippet truncation.
      expect(hit?.snippet.length).toBe(200);
      expect(hit?.source).toBe("wiki");
      expect(hit?.citation).toBe("id-1");
    });

    it("test_search_passes_sources_filter_through_to_lance_only_when_set", async () => {
      let withSources: { sources?: unknown } = {};
      let withoutSources: { sources?: unknown } = {};
      const stub = stubLanceIndex([], (_q, o) => {
        const opts = o as { sources?: unknown };
        if (opts.sources !== undefined) withSources = opts;
        else withoutSources = opts;
      });
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      await adapter.search("q", { sources: ["wiki"] });
      await adapter.search("q");
      expect((withSources.sources as string[])?.[0]).toBe("wiki");
      expect(withoutSources.sources).toBeUndefined();
    });
  });

  describe("status + close + unwrap", () => {
    it("test_status_reports_hybrid_backend_with_zero_counts", () => {
      const stub = stubLanceIndex([]);
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      const status = adapter.status();
      expect(status.backend).toBe("hybrid");
      expect(status.filesIndexed).toBe(0);
      expect(status.chunksIndexed).toBe(0);
    });

    it("test_close_delegates_to_inner_LanceIndex", async () => {
      const stub = stubLanceIndex([]);
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      expect(stub.__isClosed()).toBe(false);
      await adapter.close();
      expect(stub.__isClosed()).toBe(true);
    });

    it("test_unwrap_returns_the_inner_LanceIndex", () => {
      const stub = stubLanceIndex([]);
      // biome-ignore lint/suspicious/noExplicitAny: cross-package structural stub
      const adapter = new LanceMemoryAdapter(stub as any);
      expect(adapter.unwrap()).toBe(stub);
    });
  });
});
