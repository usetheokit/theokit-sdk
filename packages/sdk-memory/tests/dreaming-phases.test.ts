/**
 * sdk-memory `dreaming-phases` unit test (iter 54).
 *
 * Validates the iter 54 hybrid copy of
 * `internal/memory/dreaming/phases.ts` from sdk-core. sdk-memory now
 * ships the canonical 3-phase consolidation (light/REM/deep) that the
 * future `dreaming-run` move will compose with.
 *
 * sdk-core retains its copy for v1.x dreaming back-compat.
 * Both copies byte-equivalent at runtime (same threshold defaults
 * 0.95 dedup / 0.75 cluster, same cosine similarity formula, same
 * union-find single-link clustering shape).
 *
 * Embedding runtime is stub-injected (deterministic numeric vectors)
 * so the test exercises ONLY the chunker/dedup/cluster math —
 * no provider calls.
 */

import type { EmbeddingRuntime, MemoryFact } from "@theokit/sdk-memory";
import {
  type Cluster,
  type ClusterResult,
  type DedupResult,
  deepPhase,
  lightPhase,
  remPhase,
} from "@theokit/sdk-memory";
import { describe, expect, it } from "vitest";

/** Build a deterministic EmbeddingRuntime that maps text → fixed vector. */
function stubEmbedding(textToVec: Record<string, ReadonlyArray<number>>): EmbeddingRuntime {
  return {
    embed: async (texts: ReadonlyArray<string>): Promise<number[][]> =>
      texts.map((t) => [...(textToVec[t] ?? [0, 0, 0])]),
    dimension: 3,
    providerId: "stub",
    model: "stub-model",
  } as unknown as EmbeddingRuntime;
}

const fact = (text: string): MemoryFact => ({ text });

const ONE_HOT_DIMENSION = 512;

/** `count` facts whose texts are `fact number <i>`, so each maps to its own one-hot vector. */
const distinctFacts = (count: number): MemoryFact[] =>
  Array.from({ length: count }, (_, i) => fact(`fact number ${i}`));

/** An embedding that gives `fact number <i>` a one-hot vector at index i: every pair has cosine 0. */
function oneHotEmbedding(): EmbeddingRuntime {
  return {
    embed: async (texts: ReadonlyArray<string>): Promise<number[][]> =>
      texts.map((text) => {
        const vector = new Array<number>(ONE_HOT_DIMENSION).fill(0);
        vector[Number(text.replace("fact number ", ""))] = 1;
        return vector;
      }),
    dimension: ONE_HOT_DIMENSION,
    providerId: "stub",
    model: "stub-model",
  } as unknown as EmbeddingRuntime;
}

describe("sdk-memory dreaming-phases (iter 54)", () => {
  describe("lightPhase", () => {
    it("test_returns_facts_unchanged_when_count_le_1", async () => {
      const embedding = stubEmbedding({});
      const empty = await lightPhase([], embedding);
      expect(empty.kept.length).toBe(0);
      expect(empty.duplicatesRemoved).toBe(0);

      const one = await lightPhase([fact("only")], embedding);
      expect(one.kept.length).toBe(1);
      expect(one.duplicatesRemoved).toBe(0);
    });

    it("test_drops_near_duplicate_with_cosine_above_threshold", async () => {
      // Two facts with identical vectors (cosine = 1.0) should dedup.
      const embedding = stubEmbedding({
        a: [1, 0, 0],
        b: [1, 0, 0], // identical → cosine 1.0 ≥ 0.95
        c: [0, 1, 0], // orthogonal → keep
      });
      const result: DedupResult = await lightPhase([fact("a"), fact("b"), fact("c")], embedding);
      expect(result.kept.length).toBe(2);
      expect(result.duplicatesRemoved).toBe(1);
      // First-seen wins.
      expect(result.kept[0]?.text).toBe("a");
      expect(result.kept[1]?.text).toBe("c");
    });

    it("test_keeps_orthogonal_facts_below_threshold", async () => {
      const embedding = stubEmbedding({
        a: [1, 0, 0],
        b: [0, 1, 0],
        c: [0, 0, 1],
      });
      const result = await lightPhase([fact("a"), fact("b"), fact("c")], embedding);
      expect(result.kept.length).toBe(3);
      expect(result.duplicatesRemoved).toBe(0);
    });
  });

  describe("remPhase", () => {
    it("test_empty_input_returns_empty_clusters", async () => {
      const embedding = stubEmbedding({});
      const result: ClusterResult = await remPhase([], embedding);
      expect(result.clusters.length).toBe(0);
    });

    it("test_clusters_thematically_related_facts_above_threshold", async () => {
      // Two pairs of high-cosine facts → 2 clusters.
      const embedding = stubEmbedding({
        "ai short": [1, 0, 0],
        "ai long": [0.99, 0.05, 0], // cosine ≈ 0.999 → cluster with "ai short"
        "go short": [0, 1, 0],
        "go long": [0.05, 0.99, 0], // cosine ≈ 0.998 → cluster with "go short"
      });
      const result = await remPhase(
        [fact("ai short"), fact("ai long"), fact("go short"), fact("go long")],
        embedding,
      );
      expect(result.clusters.length).toBe(2);
      // Each cluster has 2 members.
      const sizes = result.clusters.map((c) => c.members.length).sort();
      expect(sizes).toEqual([2, 2]);
    });

    it("test_orthogonal_facts_form_singleton_clusters", async () => {
      const embedding = stubEmbedding({
        a: [1, 0, 0],
        b: [0, 1, 0],
        c: [0, 0, 1],
      });
      const result = await remPhase([fact("a"), fact("b"), fact("c")], embedding);
      expect(result.clusters.length).toBe(3);
      for (const c of result.clusters) expect(c.members.length).toBe(1);
    });

    it("test_representative_text_is_longest_member", async () => {
      const embedding = stubEmbedding({
        short: [1, 0, 0],
        "the longer one": [1, 0, 0],
      });
      const result = await remPhase([fact("short"), fact("the longer one")], embedding);
      expect(result.clusters.length).toBe(1);
      expect(result.clusters[0]?.representativeText).toBe("the longer one");
    });

    // B-380: the 500-fact cap drops the remainder from clustering, and the result has to say how
    // many it dropped. One-hot vectors keep every fact distinct, so nothing merges the count away.
    it("remPhase reports one fact left out of 501", async () => {
      const rem = await remPhase(distinctFacts(501), oneHotEmbedding());
      expect(rem.factsLeftOut).toBe(1);
    });

    it("remPhase reports zero left out at 500", async () => {
      const rem = await remPhase(distinctFacts(500), oneHotEmbedding());
      expect(rem.factsLeftOut).toBe(0);
    });

    it("remPhase reports zero left out for no facts", async () => {
      const rem = await remPhase([], oneHotEmbedding());
      expect(rem.factsLeftOut).toBe(0);
    });
  });

  describe("deepPhase", () => {
    it("test_returns_empty_string_for_empty_clusters", () => {
      expect(deepPhase([], 0)).toBe("");
    });

    it("test_renders_iso_timestamp_header_and_cluster_sections", () => {
      const clusters: Cluster[] = [
        {
          representativeText: "ai consolidation",
          members: [fact("ai short"), fact("ai consolidation")],
        },
        {
          representativeText: "go runtime",
          members: [fact("go runtime")],
        },
      ];
      const md = deepPhase(clusters, Date.UTC(2026, 0, 1, 12, 0, 0));
      expect(md).toContain("# Dreamed 2026-01-01T12:00:00.000Z");
      expect(md).toContain("## Cluster 1: ai consolidation");
      expect(md).toContain("- ai short");
      expect(md).toContain("- ai consolidation");
      expect(md).toContain("## Cluster 2: go runtime");
      expect(md.endsWith("\n")).toBe(true);
    });
  });
});
