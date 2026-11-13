import { MemoryFactNotRemovableError } from "./errors.js";
import {
  readFactEntries,
  removeFactFromMarkdown,
} from "./internal/memory/storage/markdown-store.js";
import type { MemorySettings } from "./types/agent.js";

/**
 * One fact in the built-in memory store, as {@link listMemoryFacts} reports it.
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

/** Only `directory` and `userId` decide where memory lives; the rest of `MemorySettings` is ignored. */
type LocationSettings = Partial<MemorySettings>;

function locationOf(settings: LocationSettings | undefined) {
  return {
    ...(settings?.directory !== undefined ? { directory: settings.directory } : {}),
    ...(settings?.userId !== undefined ? { userId: settings.userId } : {}),
  };
}

/**
 * Every fact in the built-in memory store: per-memory files and legacy `## Facts` bullets, from the
 * write root, the project store and the Claude Code CLI's store. Same entries and order the agent
 * reads. Accepts the public `MemorySettings` (only `directory` and `userId` are used).
 *
 * @public
 */
export async function listMemoryFacts(
  cwd: string,
  config?: LocationSettings,
): Promise<StoredMemoryFact[]> {
  const entries = await readFactEntries(cwd, locationOf(config));
  return entries.map((e) => ({
    id: e.id,
    text: e.fact.text,
    ...(e.fact.modified !== undefined ? { modified: e.fact.modified } : {}),
    root: e.root,
    removable: e.removable,
  }));
}

/**
 * Remove one fact by `id`. Deletes a per-memory file and its `MEMORY.md` index line, or one legacy
 * bullet inside `## Facts`. Serialized with the SDK's writer and written atomically.
 *
 * Resolves `true` when removed, `false` when no entry has that id.
 *
 * Search index: removal does NOT touch the memory search index. Corpus sync only adds or
 * re-embeds files that exist; it does not drop the chunks of a file that disappeared, so a
 * removed fact can still be returned by index-backed recall until that index is rebuilt.
 *
 * @throws {MemoryFactNotRemovableError} the entry is outside the write root; the SDK does not
 * delete another tool's memory.
 * @public
 */
export function removeMemoryFact(
  cwd: string,
  id: string,
  config?: LocationSettings,
): Promise<boolean> {
  return removeFactFromMarkdown(
    cwd,
    id,
    locationOf(config),
    (factId, root) => new MemoryFactNotRemovableError(factId, root),
  );
}
