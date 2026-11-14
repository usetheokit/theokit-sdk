import { MemoryFactNotRemovableError } from "./errors.js";
import type { MemorySettings } from "./types/agent.js";

export { MemoryFactNotRemovableError };

/**
 * One memory in the built-in markdown store.
 *
 * @public
 */
export interface StoredMemoryFact {
  /** Stable for the life of the entry: the per-memory file's name, or a hash of a legacy bullet's root + text. */
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
 * Search index: the sqlite index's rows for the deleted file (or for `MEMORY.md`, when a legacy
 * bullet went) are deleted here, so the fact is not recalled before the next sync; that sync also
 * prunes any file that left the disk and re-chunks the edited `MEMORY.md`. The Lance backend is not
 * touched: its ids are content hashes with no link to a file, so a Lance index keeps the fact until
 * it is rebuilt.
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
const load = () => import("./internal/memory/facts-api.js");
