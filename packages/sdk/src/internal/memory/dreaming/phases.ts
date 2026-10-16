import type { EmbeddingRuntime } from "../embedding-adapter.js";
import type { MemoryFact, MemoryKind } from "../types.js";

/**
 * Dreaming/REM phase logic.
 *
 * Three phases:
 *   - **light** — drop near-duplicate facts (cosine similarity > 0.95).
 *   - **REM**  — cluster thematically related facts (cosine ≥ 0.75).
 *   - **deep** — pick a representative bullet per cluster (longest text
 *                wins) and emit consolidated markdown notes.
 *
 * @internal
 */

export interface DedupResult {
  kept: MemoryFact[];
  duplicatesRemoved: number;
}

export interface Cluster {
  representativeText: string;
  members: ReadonlyArray<MemoryFact>;
}

export interface ClusterResult {
  clusters: Cluster[];
  /** How many input facts past the per-sweep cap were not clustered; 0 when none were. */
  factsLeftOut: number;
}

const DEFAULT_DEDUP_THRESHOLD = 0.95;
const DEFAULT_CLUSTER_THRESHOLD = 0.75;

/**
 * Kinds a sweep may consolidate. ADR-14 partitions the vocabulary into three buckets and only
 * this one is a merge candidate; the rest are protected for a reason that survives the sweep
 * being non-destructive.
 *
 * `user`, `feedback` and `reference` are ATOMIC: there is nothing to merge and the loss is
 * irreversible. Two corrections a user gave on different days can read alike and are not the
 * same correction. An untyped fact is protected too — a kind that nobody declared is not a
 * licence to treat it as consolidatable.
 *
 * Why this matters even though nothing is deleted: dedup drops the near-duplicate from the
 * CLUSTERING INPUT, and the cluster's representative is what the search index returns. The
 * source file survives; the artefact the agent reads does not. That is ADR-14's third rule —
 * the invariant is about what the agent reads, not what survives on disk.
 */
// Typed against `MemoryKind` rather than `string`, so the compiler checks these against the vocabulary
// they mirror. They were `Set<string>` and CONSOLIDATABLE_KINDS held "session" — not a member of
// `MemoryKind`, and rejected by `markdown-store.assertWritable` before any fact is written, so no
// fact reaching this policy could ever carry it. The arm read as though sessions were consolidatable
// while no session could exist. Adding a member to either set is now a type error unless `MemoryKind`
// gains it deliberately.
const CONSOLIDATABLE_KINDS: ReadonlySet<MemoryKind> = new Set(["project"]);
const ATOMIC_KINDS: ReadonlySet<MemoryKind> = new Set(["user", "feedback", "reference"]);

/**
 * Three levels, graded by how much the store knows about the entry. The middle one exists
 * because the first draft of this filter did not have it and broke the common case.
 *
 * - ATOMIC (`user`, `feedback`, `reference`) — never deduplicated. Two corrections given on
 *   different days can read alike and are not the same correction.
 * - CONSOLIDATABLE (`project`, `session`) — near-duplicate dedup at the similarity threshold.
 *   Overlapping project facts are exactly what a sweep is for.
 * - UNTYPED — EXACT duplicates only. A hand-written bullet under `## Facts` carries no kind,
 *   and the store's own header invites editing those by hand, so untyped is the common case
 *   rather than an edge one. Treating it as atomic would disable the sweep for most stores;
 *   treating it as consolidatable would let a near-duplicate of an untyped correction be
 *   dropped. Exact-match is the only claim the store can make without inferring a kind, which
 *   is the rule this codebase already applies one field over.
 */
type DedupPolicy = "never" | "exact" | "similar";

function dedupPolicy(fact: MemoryFact): DedupPolicy {
  if (fact.kind === undefined) return "exact";
  if (ATOMIC_KINDS.has(fact.kind)) return "never";
  return CONSOLIDATABLE_KINDS.has(fact.kind) ? "similar" : "never";
}

/** Whitespace and case collapsed; nothing else. Not a similarity measure — an identity one. */
function normalizeForExactMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
}

/**
 * Light phase — drop facts whose embedding is too similar to one already kept.
 *
 * Protected kinds bypass deduplication entirely and are returned untouched, so a sweep can
 * never conflate two of them into one representative.
 *
 * "Drop" here means DROPPED FROM THE RETURNED LIST. Nothing on disk is deleted, by any phase of
 * this sweep, today.
 *
 * BEFORE YOU ADD PRUNING HERE, READ THIS. The security contract for this store requires a backup
 * to precede any destructive operation (SOP-06-05 step 7). That requirement is currently LATENT
 * — not satisfied, not waived — precisely because the sweep only ever adds notes and filters a
 * list. There is no backup implementation in this package, and an audit that looked for one
 * recorded its absence as having no present consequence.
 *
 * The first commit that makes this sweep delete a file from disk is the commit that makes the
 * gap real, and it is also the commit whose author will have no reason to know this line exists.
 * That is why the trigger is written beside the code that would trip it rather than in the audit
 * that found it: a gap recorded in a reviewer's file reappears as a surprise; a gap recorded
 * here stops the person adding pruning.
 */
export async function lightPhase(
  facts: ReadonlyArray<MemoryFact>,
  embedding: EmbeddingRuntime,
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): Promise<DedupResult> {
  if (facts.length <= 1) return { kept: [...facts], duplicatesRemoved: 0 };
  const never = facts.filter((f) => dedupPolicy(f) === "never");
  const exact = facts.filter((f) => dedupPolicy(f) === "exact");
  const similar = facts.filter((f) => dedupPolicy(f) === "similar");

  // Exact pass: identity, not similarity. No embedding call, no threshold, no judgement.
  const seen = new Set<string>();
  const exactKept: MemoryFact[] = [];
  let removed = 0;
  for (const f of exact) {
    const key = normalizeForExactMatch(f.text);
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    exactKept.push(f);
  }

  const sim =
    similar.length > 1
      ? await dedupCandidates(similar, embedding, threshold)
      : { kept: [...similar], duplicatesRemoved: 0 };

  // Protected facts keep their original relative position at the front: they were never in
  // the running, and putting them back through the sort would imply they had been judged.
  return {
    kept: [...never, ...exactKept, ...sim.kept],
    duplicatesRemoved: removed + sim.duplicatesRemoved,
  };
}

async function dedupCandidates(
  facts: ReadonlyArray<MemoryFact>,
  embedding: EmbeddingRuntime,
  threshold: number,
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
// When facts exceed the cap, a deterministic subsample is taken so the
// sweep is bounded. The remaining facts are carried to the next sweep.
const DEFAULT_MAX_FACTS_PER_SWEEP = 500;

/** REM phase — single-link agglomerative clustering by cosine similarity. */
export async function remPhase(
  facts: ReadonlyArray<MemoryFact>,
  embedding: EmbeddingRuntime,
  threshold: number = DEFAULT_CLUSTER_THRESHOLD,
  maxFactsPerSweep: number = DEFAULT_MAX_FACTS_PER_SWEEP,
): Promise<ClusterResult> {
  // KNOWN GAP, deliberately not closed here. Protected kinds are excluded from DEDUP — a
  // near-duplicate correction is never dropped — but they still reach CLUSTERING, and a cluster
  // carries one representative into the consolidated note.
  //
  // Filtering them out here too was tried and reverted: untyped is the common case (hand-written
  // bullets carry no kind), so excluding it disables consolidation for most stores, and it broke
  // three existing golden tests. The damage is also smaller than in the dedup case — the source
  // files survive and remain readable, so what a cluster costs is nuance in an ADDITIONAL
  // artefact rather than a lost entry.
  //
  // It becomes real damage only if recall serves notes INSTEAD of sources. That depends on what
  // the index covers, which is not settled here. Recorded rather than silently accepted.
  if (facts.length === 0) return { clusters: [], factsLeftOut: 0 };
  // T4.6 — cap: subsample when facts exceed budget. Deterministic
  // sort by text hash so the same input always picks the same subset.
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
