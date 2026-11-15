import { MemoryFactNotRemovableError } from "./errors.js";
import type { MemorySettings } from "./types/agent.js";

export { MemoryFactNotRemovableError };

/**
 * One memory in the built-in markdown store.
 *
 * @public
 */
export interface StoredMemoryFact {
  /** Stable for the life of the entry: the per-memory file's name in the write root; for another root, a root hash and the file name; for a legacy bullet, a hash of root + text. */
  id: string;
  text: string;
  modified?: string;
  /** The root it was read from. */
  root: string;
  /** True only for entries under the write root (`memory.directory`, default `<cwd>/.theokit/memory`). */
  removable: boolean;
}

/**
 * Every memory in the built-in store, in the order the agent reads them: per-memory files first
 * (oldest first), then legacy `## Facts` bullets. Reads every read root, including the Claude Code
 * CLI's store; those entries have `removable: false`. `settings` is the same `memory` object given
 * to `Agent.create`; only its location fields matter and `enabled` is not consulted.
 *
 * @public
 */
export function listMemoryFacts(
  cwd: string,
  settings?: Partial<MemorySettings>,
): Promise<StoredMemoryFact[]> {
  return load().then((m) => m.listFactEntries(cwd, settings));
}

/**
 * Remove one memory by `id`: the per-memory file and its `MEMORY.md` index line, or one legacy
 * bullet inside `## Facts`. Serialized with the SDK's own writes and written atomically. Resolves
 * `true` when removed and `false` when no entry has that id. Rejects with
 * {@link MemoryFactNotRemovableError} for an entry outside the write root.
 *
 * Search indexes: removal updates them. The sqlite index re-walks the corpus, so the deleted file
 * leaves it and an edited `MEMORY.md` is re-chunked in place (the other facts stay searchable;
 * vectors for re-chunked text are filled in by the next `sync()`). In a Lance index, only
 * `source: "memory"` rows are touched: a row that is the fact is deleted, and a migrated chunk that
 * contains it is rewritten without it (deleted when only headings are left), keeping its vector.
 * Rows stay while another stored entry has the same text. Open `LanceIndex` handles are refreshed,
 * so an agent already running does not recall it. A missing index or an absent `@lancedb/lancedb`
 * means nothing to drop.
 *
 * Two identical legacy bullets in one root share an id, so removing that id removes one of them
 * (the first); the second is still listed under the same id.
 *
 * @public
 */
export function removeMemoryFact(
  cwd: string,
  id: string,
  settings?: Partial<MemorySettings>,
): Promise<boolean> {
  return load().then((m) => m.removeFactAndForget(cwd, id, settings));
}

// Loaded on demand so the store and index code stay out of the entry bundle.
const load = () => import("./internal/memory/storage/facts-api.js");
