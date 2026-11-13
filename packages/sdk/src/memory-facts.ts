import { MemoryFactNotRemovableError } from "./errors.js";
import { listFactEntries, removeFactEntry } from "./internal/memory/storage/markdown-store.js";
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
  return listFactEntries(cwd, settings);
}

/**
 * Remove one memory by `id`: the per-memory file and its `MEMORY.md` index line, or one legacy
 * bullet inside `## Facts`. Serialized with the SDK's own writes and written atomically. Resolves
 * `true` when removed and `false` when no entry has that id. Rejects with
 * {@link MemoryFactNotRemovableError} for an entry outside the write root.
 *
 * Search index: removal does NOT update the memory search index (sqlite/lance). The index is
 * rebuilt from the files on its next refresh, which drops the deleted file's chunks; until then a
 * search may still return the removed fact.
 *
 * @public
 */
export function removeMemoryFact(
  cwd: string,
  id: string,
  settings?: Partial<MemorySettings>,
): Promise<boolean> {
  return removeFactEntry(cwd, id, settings);
}
