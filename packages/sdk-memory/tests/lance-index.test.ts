/**
 * sdk-memory `lance-index` unit test (iter 68).
 *
 * Validates the iter 68 hybrid copy of `internal/memory/lance-index.ts`
 * from sdk-core. sdk-memory now ships the canonical LanceDB-backed
 * memory index per ADR D43.
 *
 * sdk-core retains its copy for v1.x Lance back-compat.
 * Both copies byte-equivalent at runtime (same lance_backend_unavailable
 * typed error on missing peer, same EC-1 SQL string predicate with
 * `'`→`''` escape, same EC-8 Arrow FixedSizeList listSize/fixedSize
 * dimension check, same bootstrap-then-delete table-init pattern).
 *
 * Pure helpers (`isLanceAvailable` + `lanceStoragePath` +
 * `requireLance` error path) always run. Live LanceDB tests are gated
 * on the optional `@lancedb/lancedb` peer; on environments without
 * it the live tests skip gracefully.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type EmbeddingRuntime,
  isLanceAvailable,
  LanceIndex,
  lanceStoragePath,
  resolveMemoryRoot,
} from "@theokit/sdk-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function stubEmbedding(
  textToVec: Record<string, ReadonlyArray<number>>,
  dim = 3,
): EmbeddingRuntime {
  return {
    embed: async (texts: string[]) =>
      texts.map((t) => [...(textToVec[t] ?? new Array(dim).fill(0))]),
    dimension: dim,
    providerId: "stub",
    model: "stub",
  } as unknown as EmbeddingRuntime;
}

describe("sdk-memory lance-index (iter 68)", () => {
  describe("pure helpers — always run", () => {
    it("test_lanceStoragePath_resolves_under_the_default_memory_root", () => {
      expect(lanceStoragePath(resolveMemoryRoot("/tmp/x"))).toBe("/tmp/x/.theokit/memory/lance");
    });

    // The half the default hides: with `memory.directory` set the Lance store follows the root
    // instead of re-deriving `<cwd>/.theokit/memory` from a literal of its own (#463).
    it("test_lanceStoragePath_follows_a_configured_memory_directory", () => {
      expect(lanceStoragePath(resolveMemoryRoot("/tmp/x", { directory: "/srv/mem" }))).toBe(
        "/srv/mem/lance",
      );
    });

    it("test_isLanceAvailable_returns_boolean_consistent_with_environment", () => {
      // The function itself MUST always return a boolean — runtime decides
      // whether @lancedb/lancedb is installed. We don't assert true/false
      // (depends on env); we assert the shape.
      expect(typeof isLanceAvailable()).toBe("boolean");
    });

    // Only meaningful when @lancedb/lancedb is NOT installed. When it IS installed the runner must
    // report SKIPPED: the bare `return` made this a no-op that still counted as a passing test.
    it.skipIf(isLanceAvailable())(
      "test_LanceIndex_open_throws_typed_error_when_lancedb_missing",
      async () => {
        const cwd = await mkdtemp(join(tmpdir(), "sdk-memory-lance-missing-"));
        try {
          await expect(
            LanceIndex.open({ cwd, embedding: stubEmbedding({}) }),
          ).rejects.toMatchObject({
            message: expect.stringContaining("`@lancedb/lancedb` is not installed"),
          });
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      },
    );
  });

  describe("LanceDB live roundtrip (skipped when @lancedb/lancedb missing)", () => {
    let cwd: string;

    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), "sdk-memory-lance-live-"));
    });
    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    it.skipIf(!isLanceAvailable())("test_add_search_count_remove_roundtrip", async () => {
      const embedding = stubEmbedding(
        {
          alpha: [1, 0, 0],
          beta: [0, 1, 0],
          gamma: [0, 0, 1],
        },
        3,
      );
      const index = await LanceIndex.open({ cwd, embedding });

      await index.addFacts([
        {
          id: "id-alpha",
          text: "alpha",
          source: "memory",
          namespace: "ns",
          scope: "agent",
          user_id: "u",
          timestamp: 1,
        },
        {
          id: "id-beta",
          text: "beta",
          source: "memory",
          namespace: "ns",
          scope: "agent",
          user_id: "u",
          timestamp: 2,
        },
        {
          id: "id-gamma",
          text: "gamma",
          source: "memory",
          namespace: "ns",
          scope: "agent",
          user_id: "u",
          timestamp: 3,
        },
      ]);

      // Search for vector closest to "beta" — top-1 hit must be id-beta.
      const hits = await index.search("beta", { namespace: "ns", limit: 1 });
      expect(hits.length).toBe(1);
      expect(hits[0]?.id).toBe("id-beta");
      expect(hits[0]?.score).toBeGreaterThan(0);
      expect(hits[0]?.score).toBeLessThanOrEqual(1);

      // EC-1 injection guard: a namespace value with `'` chars must not
      // break the predicate (gets `''` escaped). 0 hits expected because
      // no fact lives in the malicious namespace.
      const inj = await index.search("alpha", {
        namespace: "ns' OR '1'='1",
      });
      expect(Array.isArray(inj)).toBe(true);
      expect(inj.length).toBe(0);

      // countFacts returns total rows.
      const count = await index.countFacts("ns");
      expect(count).toBeGreaterThanOrEqual(3);

      // Remove one fact + verify count drops.
      await index.removeFacts(["id-alpha"]);
      const after = await index.countFacts("ns");
      expect(after).toBe(count - 1);

      await index.close();
    });
  });
});
