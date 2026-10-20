import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "../../diagnostics.js";
import { replaceFileAtomic } from "../../persistence/atomic-write.js";
import { withCwdMutex } from "../../persistence/cwd-mutex.js";
import type { EmbeddingRuntime } from "../embedding-adapter.js";
import { readFactsFromMarkdown } from "../storage/markdown-store.js";
import { type MemoryRoot, resolveMemoryRoot } from "../storage/memory-root.js";
import { appendDiaryEntry } from "./diary.js";
import { deepPhase, lightPhase, remPhase } from "./phases.js";

/**
 * Dreaming sweep orchestrator (ADR D7 of memory-system-peer-project-parity).
 *
 * Phases:
 *   1. **light** — drop near-duplicate facts via cosine similarity.
 *   2. **REM**  — cluster thematically related facts.
 *   3. **deep** — write a `notes/dreamed-<ts>.md` per sweep with consolidated
 *                  clusters; append a diary entry.
 *
 * All file writes go through `replaceFileAtomic` (EC-3) and the entire sweep
 * holds the per-cwd mutex so a `Remember:` append can't race it.
 *
 * @internal
 */

export interface DreamingOptions {
  cwd: string;
  /**
   * The memory root to sweep. Defaults to the project store — right for a caller with no
   * `memory.directory`, and wrong for one that has it, which is why it is passable (#463).
   */
  memoryRoot?: MemoryRoot;
  embedding: EmbeddingRuntime;
  dedupThreshold?: number;
  clusterThreshold?: number;
  /** Test hook — fixed timestamp for the run. */
  now?: () => number;
}

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

export function runDreamingSweep(options: DreamingOptions): Promise<DreamingResult> {
  return withCwdMutex(`dream:${options.cwd}`, () => runInner(options));
}

async function runInner(options: DreamingOptions): Promise<DreamingResult> {
  const now = options.now ?? Date.now;
  const timestampMs = now();
  try {
    const root = options.memoryRoot ?? resolveMemoryRoot(options.cwd);
    const facts = await readFactsFromMarkdown(
      options.cwd,
      options.memoryRoot ? { directory: options.memoryRoot } : undefined,
    );
    if (facts.length === 0) {
      return emptyResult("skipped");
    }
    const dedup = await lightPhase(facts, options.embedding, options.dedupThreshold);
    const rem = await remPhase(dedup.kept, options.embedding, options.clusterThreshold);
    const notesWritten = await writeConsolidatedNotes(root, rem.clusters, timestampMs);
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
    await appendDiaryEntry(root, {
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
    diag(`[theokit-sdk] dreaming sweep failed: ${message}\n`);
    return emptyResult("error");
  }
}

async function writeConsolidatedNotes(
  root: MemoryRoot,
  clusters: ReadonlyArray<{ representativeText: string; members: ReadonlyArray<{ text: string }> }>,
  timestampMs: number,
): Promise<number> {
  if (clusters.length === 0) return 0;
  const notesDir = join(root, "notes");
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
