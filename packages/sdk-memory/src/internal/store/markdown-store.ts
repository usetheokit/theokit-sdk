import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { notesDir, resolveMemoryRoot } from "@theokit/sdk/internal/memory-store";

/**
 * Markdown-first memory storage — re-exported from `@theokit/sdk`, not reimplemented here.
 *
 * This file used to be a full copy (iter 56, Stage 3 source-move #13). The copy went stale: `#389`
 * moved the layout from bullets under `MEMORY.md ## Facts` to a file per memory, and the
 * Claude Code compatibility work added two more read roots — both landed in the SDK's copy and
 * neither in this one. Because `Memory.runDreamingSweep` routes through this package whenever it is
 * installed, **the copy that ran was not the copy anyone had updated**: installing
 * `@theokit/sdk-memory` made every memory the SDK had written unreadable, reported as
 * `factsBefore: 0` — a number that reads exactly like an empty store (#430).
 *
 * theokit#160 fixed the identical shape for the embedding runtime, in this same package pair, by
 * importing one implementation instead of syncing two. Same remedy here. Re-syncing the copy would
 * have fixed today's divergence and left tomorrow's free to happen.
 *
 * The re-exported signatures are supersets of what this package used to expose — the added
 * parameters are optional — so nothing that called them before has to change.
 *
 * @internal
 */
export {
  appendFact,
  appendFactToMarkdown,
  asMemoryRoot,
  ceilingReachedError,
  claudeProjectMemoryDir,
  collectMarkdownFiles,
  type DiscoveredFile,
  defaultIndexPath,
  indexBudgetWarning,
  lanceStoragePath,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  type MemoryLocationConfig,
  type MemoryRoot,
  memoryIndexRoot,
  memoryMdPath,
  memoryReadRoots,
  notesDir,
  projectMemoryDir,
  readAllSqliteFacts,
  readFacts,
  readFactsFromMarkdown,
  resolveMaxFacts,
  resolveMemoryRoot,
  type SqliteFactRow,
} from "@theokit/sdk/internal/memory-store";

/** One note discovered under `notes/`: its file name without the `.md` suffix, and its absolute path. */
export interface NoteFile {
  slug: string;
  path: string;
}

/**
 * List the `.md` files directly under `notes/`. Returns `[]` when the directory does not exist, so
 * a workspace that has never written a note is not an error. Does not recurse into sub-directories.
 *
 * Stays here rather than moving to the shared store: notes are this package's concept, and only
 * this package reads them.
 */
export async function listNotes(cwd: string): Promise<NoteFile[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(notesDir(resolveMemoryRoot(cwd)));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      slug: name.replace(/\.md$/, ""),
      path: join(notesDir(resolveMemoryRoot(cwd)), name),
    }));
}
