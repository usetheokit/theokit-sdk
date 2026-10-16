import type { EmbeddingRuntime } from "../embedding/embedding-adapter.js";
import type { MemoryFact } from "../memory-types.js";

/**
 * Dreaming/REM phase logic.
 *
 * Three phases:
 *   - **light** — drop near-duplicate facts (cosine similarity > 0.95).
 *   - **REM**  — cluster thematically related facts (cosine ≥ 0.75).
 *   - **deep** — pick a representative bullet per cluster (longest text
 *                wins) and emit consolidated markdown notes.
 *
 * Iter 54 (Stage 3 source-move #11): hybrid copy from sdk-core's
 * `internal/memory/dreaming/phases.ts`. sdk-core retains its copy
 * for v1.x dreaming back-compat; sdk-memory ships the canonical copy
 * that future `dreaming/run.ts` move will compose with as a sibling.
 * Dependencies (both moved): `EmbeddingRuntime` (iter 45) +
 * `MemoryFact` (iter 52).
 *
 * Flat-naming convention (not `dreaming/phases.ts`): sdk-memory's
 * `internal/` directory stays flat to keep relative-import paths
 * uniform across iter 44-53. The `dreaming-` prefix preserves the
 * topical grouping without a sub-directory.
 *
 * @internal
 */

export interface DedupResult {
  kept: MemoryFact[];
  duplicatesRemoved: number;
}

/**
 * A group of facts the REM phase judged related. `representativeText` is the
 * text of the longest member, used as the cluster's heading in the consolidated
 * note — longest, not most central, so it is a readable label rather than a
 * centroid. `members` includes that fact as well.
 */
export interface Cluster {
  representativeText: string;
  members: ReadonlyArray<MemoryFact>;
}

/**
 * What {@link remPhase} produced. Every input fact inside the per-sweep cap
 * appears in exactly one cluster, so a fact related to nothing comes back as a
 * cluster of one — the count is not a count of *interesting* groupings. Facts
 * past the cap are counted in `factsLeftOut` and appear in no cluster.
 */
export interface ClusterResult {
  clusters: Cluster[];
  /** How many input facts past the per-sweep cap were not clustered; 0 when none were. */
  factsLeftOut: number;
}

const DEFAULT_DEDUP_THRESHOLD = 0.95;
const DEFAULT_CLUSTER_THRESHOLD = 0.75;

/** Light phase — drop facts whose embedding is too similar to one already kept. */
export async function lightPhase(
  facts: ReadonlyArray<MemoryFact>,
  embedding: EmbeddingRuntime,
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): Promise<DedupResult> {
  if (facts.length <= 1) return { kept: [...facts], duplicatesRemoved: 0 };
  const vectors = await embedding.embed(facts.map((f) => f.text));
  const keptIdx: number[] = [];
  const keptVecs: number[][] = [];
  for (let i = 0; i < facts.length; i++) {
    const vec = vectors[i] ?? [];
    const isDup = keptVecs.some((kept) => cosineSimilarity(vec, kept) >= threshold);
    if (isDup) continue;
    keptIdx.push(i);
    keptVecs.push(vec);
  }
  const kept = keptIdx.map((i) => facts[i] as MemoryFact);
  return { kept, duplicatesRemoved: facts.length - kept.length };
}

// T4.6 — cap facts per sweep to prevent O(N²) blowup. 500 facts →
// 125K comparisons (acceptable). 5000 facts → 12.5M (unacceptable).
// Over the cap, the clustering considers the FIRST `maxFactsPerSweep`
// facts and ignores the rest. It is deterministic (same input, same
// subset) but positional: nothing carries the remainder into a later
// sweep, so facts past the cap are never clustered while the ones
// before them stay in place.
const DEFAULT_MAX_FACTS_PER_SWEEP = 500;

/** REM phase — single-link agglomerative clustering by cosine similarity. */
export async function remPhase(
  facts: ReadonlyArray<MemoryFact>,
  embedding: EmbeddingRuntime,
  threshold: number = DEFAULT_CLUSTER_THRESHOLD,
  maxFactsPerSweep: number = DEFAULT_MAX_FACTS_PER_SWEEP,
): Promise<ClusterResult> {
  if (facts.length === 0) return { clusters: [], factsLeftOut: 0 };
  // T4.6 — cap: take the leading window when facts exceed the budget.
  const capped = facts.length > maxFactsPerSweep ? facts.slice(0, maxFactsPerSweep) : facts;
  const vectors = await embedding.embed(capped.map((f) => f.text));
  const clusterOfIdx = unionFindByPairs(vectors, threshold);
  const groups = bucketFactsByClusterRoot(capped, clusterOfIdx);
  return {
    clusters: [...groups.values()].map(buildClusterFromMembers),
    factsLeftOut: facts.length - capped.length,
  };
}

function unionFindByPairs(
  vectors: ReadonlyArray<ReadonlyArray<number>>,
  threshold: number,
): number[] {
  const clusterOfIdx = vectors.map((_, i) => i);
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      if (cosineSimilarity(vectors[i] ?? [], vectors[j] ?? []) >= threshold) {
        unifyClusters(clusterOfIdx, i, j);
      }
    }
  }
  return clusterOfIdx;
}

function bucketFactsByClusterRoot(
  facts: ReadonlyArray<MemoryFact>,
  clusterOfIdx: number[],
): Map<number, MemoryFact[]> {
  const groups = new Map<number, MemoryFact[]>();
  for (let i = 0; i < facts.length; i++) {
    const root = findRoot(clusterOfIdx, i);
    const list = groups.get(root) ?? [];
    list.push(facts[i] as MemoryFact);
    groups.set(root, list);
  }
  return groups;
}

function buildClusterFromMembers(members: ReadonlyArray<MemoryFact>): Cluster {
  const sorted = [...members].sort((a, b) => b.text.length - a.text.length);
  return { representativeText: sorted[0]?.text ?? "", members };
}

/** Deep phase — render consolidated markdown for the dreamed note. */
export function deepPhase(clusters: ReadonlyArray<Cluster>, timestampMs: number): string {
  if (clusters.length === 0) return "";
  const isoStamp = new Date(timestampMs).toISOString();
  const lines: string[] = [`# Dreamed ${isoStamp}`, ""];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (c === undefined) continue;
    lines.push(`## Cluster ${i + 1}: ${c.representativeText}`);
    lines.push("");
    for (const member of c.members) lines.push(`- ${member.text}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    aNorm += ai * ai;
    bNorm += bi * bi;
  }
  const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  return denom === 0 ? 0 : dot / denom;
}

function findRoot(parents: number[], i: number): number {
  let root = i;
  while (parents[root] !== root) {
    const next = parents[root] ?? root;
    if (next === root) break;
    root = next;
  }
  parents[i] = root;
  return root;
}

function unifyClusters(parents: number[], a: number, b: number): void {
  const rootA = findRoot(parents, a);
  const rootB = findRoot(parents, b);
  if (rootA !== rootB) parents[rootB] = rootA;
}
