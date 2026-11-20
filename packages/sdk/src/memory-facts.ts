import { MemoryFactAmbiguousError, MemoryFactNotRemovableError } from "./errors.js";
import type { MemorySettings } from "./types/agent.js";

export { MemoryFactAmbiguousError, MemoryFactNotRemovableError };

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
 * {@link MemoryFactNotRemovableError} for an entry outside the write root, and with
 * {@link MemoryFactAmbiguousError} (removing nothing) when the id is found in more than one root.
 *
 * Search index: inside the same critical section as the removal, the sqlite index's rows for the
 * deleted file (or for `MEMORY.md`, when a legacy bullet went) are deleted first, so a failed
 * cleanup removes nothing and the call can be retried. A sync running in another process while the
 * fact goes can re-insert its chunks; the next `sync` drops them, because it prunes indexed files
 * that left the disk and re-chunks the edited `MEMORY.md`. This function feeds only the sqlite index and
 * never touches a Lance index. The `agent.memory.delete` path does: it removes the fact's rows
 * (source `memory`, the agent's namespace, `fact_id` equal to the MemoryId) from the Lance index
 * under the agent's own memory root, after the adapter delete. Lance rows with no `fact_id`
 * (legacy chunks migrated from SQLite) are removed only when their exact id equals the fact id;
 * otherwise they stay.
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
