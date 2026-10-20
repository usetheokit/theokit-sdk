import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { replaceFileAtomic, withCwdMutex } from "@theokit/sdk/persistence";
import type { EmbeddingRuntime } from "../embedding/embedding-adapter.js";
import { readFactsFromMarkdown, resolveMemoryRoot } from "../store/markdown-store.js";
import { appendDiaryEntry } from "./dreaming-diary.js";
import { deepPhase, lightPhase, remPhase } from "./dreaming-phases.js";

/**
 * Dreaming sweep orchestrator (ADR D7 of memory-system-peer-project-parity).
 *
 * Phases:
 *   1. **light** — drop near-duplicate facts via cosine similarity.
 *   2. **REM**  — cluster thematically related facts.
 *   3. **deep** — write a `notes/dreamed-<ts>.md` per sweep with consolidated
 *                  clusters; append a diary entry.
 *
 * All file writes go through `replaceFileAtomic` (EC-3). The sweep holds a
 * mutex for the whole run, so two sweeps over the same workspace serialize.
 * Note the key is `dream:<cwd>`, while `appendFactToMarkdown` locks on the
 * memory directory — different keys, so a concurrent `Remember:` append is NOT
 * excluded by this lock. It cannot corrupt a file (each write is atomic), but a
 * fact appended after the sweep read `MEMORY.md` is simply not in the sweep.
 *
 * Iter 60 (Stage 3 source-move #17): hybrid copy from sdk-core's
 * `internal/memory/dreaming/run.ts`. sdk-core retains its copy for
 * v1.x dreaming back-compat; sdk-memory ships the canonical
 * orchestrator that composes all four sibling moves from iter 45
 * (`EmbeddingRuntime`), iter 54 (`lightPhase`+`remPhase`+`deepPhase`),
 * iter 56 (`memoryDir`+`readFactsFromMarkdown`), and iter 59
 * (`appendDiaryEntry`). Persistence sub-path provides
 * `replaceFileAtomic` + `withCwdMutex`. This closes the dreaming/
 * cluster — 4 files all in sdk-memory now.
 *
 * Flat-naming convention (not `dreaming/run.ts`): sdk-memory's
 * `internal/` directory stays flat. The `dreaming-` prefix preserves
 * the topical grouping (companion to iter 54's `dreaming-phases` and
 * iter 59's `dreaming-diary`).
 *
 * @internal
 */

export interface DreamingOptions {
  cwd: string;
  embedding: EmbeddingRuntime;
  dedupThreshold?: number;
  clusterThreshold?: number;
  /** Test hook — fixed timestamp for the run. */
  now?: () => number;
}

/**
 * What one sweep did. `skipped` means `MEMORY.md` held no facts; `error` means
 * the sweep threw and the counts are all zero.
 *
 * `factsAfter` is the count that survived in-memory deduplication, not a new
 * size for `MEMORY.md` — the sweep does not rewrite it, so the duplicates it
 * counted are still on disk and will be counted again next time. `notesWritten`
 * is 0 or 1: one consolidated note per sweep, holding every cluster.
 *
 * `diaryEntryHash` is currently always `undefined`, on every path including
 * success, even though the diary entry itself is written with a hash.
 */
export interface DreamingResult {
  status: "ok" | "skipped" | "error";
  factsBefore: number;
  factsAfter: number;
  duplicatesRemoved: number;
  clustersCreated: number;
  notesWritten: number;
  diaryEntryHash: string | undefined;
  /**
   * Deduplicated facts past the per-sweep cap that were not clustered. Set on `"ok"`, 0 on
   * `"skipped"`, and absent on `"error"`, where the sweep cannot say how many it left out.
   */
  factsLeftOut?: number;
}

/**
 * Run one consolidation sweep over `MEMORY.md`: drop near-duplicate facts,
 * cluster what is left, write a consolidated note under `notes/`, and append a
 * diary entry.
 *
 * Every fact is embedded on each sweep, and clustering compares every pair, so
 * cost grows with the square of the corpus. That is why the REM phase looks at
 * the first 500 facts only.
 *
 * Never rejects: a failure is written to stderr and reported as
 * `status: "error"`, so a sweep scheduled inside an agent run cannot break it.
 *
 * The sweep is read-only with respect to `MEMORY.md`. It produces a note beside
 * it and leaves the fact list untouched, which means running it twice produces
 * two notes over the same facts.
 */
export function runDreamingSweep(options: DreamingOptions): Promise<DreamingResult> {
  return withCwdMutex(`dream:${options.cwd}`, () => runInner(options));
}

async function runInner(options: DreamingOptions): Promise<DreamingResult> {
  const now = options.now ?? Date.now;
  const timestampMs = now();
  try {
    const facts = await readFactsFromMarkdown(options.cwd);
    if (facts.length === 0) {
      return emptyResult("skipped");
    }
    const dedup = await lightPhase(facts, options.embedding, options.dedupThreshold);
    const rem = await remPhase(dedup.kept, options.embedding, options.clusterThreshold);
    const notesWritten = await writeConsolidatedNotes(options.cwd, rem.clusters, timestampMs);
    const result: DreamingResult = {
      status: "ok",
      factsBefore: facts.length,
      factsAfter: dedup.kept.length,
      duplicatesRemoved: dedup.duplicatesRemoved,
      clustersCreated: rem.clusters.length,
      notesWritten,
      diaryEntryHash: undefined,
      factsLeftOut: rem.factsLeftOut,
    };
    await appendDiaryEntry(resolveMemoryRoot(options.cwd), {
      timestampMs,
      factsBefore: result.factsBefore,
      factsAfter: result.factsAfter,
      duplicatesRemoved: result.duplicatesRemoved,
      clustersCreated: result.clustersCreated,
      notesWritten: result.notesWritten,
    });
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[theokit-sdk] dreaming sweep failed: ${message}\n`);
    return emptyResult("error");
  }
}

async function writeConsolidatedNotes(
  cwd: string,
  clusters: ReadonlyArray<{ representativeText: string; members: ReadonlyArray<{ text: string }> }>,
  timestampMs: number,
): Promise<number> {
  if (clusters.length === 0) return 0;
  const notesDir = join(resolveMemoryRoot(cwd), "notes");
  await mkdir(notesDir, { recursive: true });
  const isoSlug = new Date(timestampMs).toISOString().replace(/[^\dT]/g, "-");
  const file = join(notesDir, `dreamed-${isoSlug}.md`);
  const body = deepPhase(clusters, timestampMs);
  await replaceFileAtomic(file, body);
  return 1;
}

function emptyResult(status: "skipped" | "error"): DreamingResult {
  const result: DreamingResult = {
    status,
    factsBefore: 0,
    factsAfter: 0,
    duplicatesRemoved: 0,
    clustersCreated: 0,
    notesWritten: 0,
    diaryEntryHash: undefined,
  };
  // An empty store left nothing out; a failed sweep cannot say, so it reports no count.
  return status === "skipped" ? { ...result, factsLeftOut: 0 } : result;
}
