import { existsSync } from "node:fs";

import { defaultIndexPath, openMemoryDb } from "../index-db.js";
import { MemoryIndexRepository } from "../index-repository.js";
import { type FactEntryInfo, listFactEntries, removeFactEntry } from "./memory-fact-entries.js";
import { type MemoryLocationConfig, memoryIndexRoot, resolveMemoryRoot } from "./memory-root.js";

export { type FactEntryInfo, listFactEntries };

/**
 * Drop the sqlite search index's rows for the changed files. Called under the store's mutex, which
 * `IndexManager.sync` also takes, so a sync cannot re-insert a removed file's chunks afterwards.
 * No index file means nothing to drop.
 */
async function forgetIndexedFiles(
  cwd: string,
  paths: ReadonlyArray<string>,
  config?: MemoryLocationConfig,
): Promise<void> {
  const filePath = defaultIndexPath(memoryIndexRoot(cwd, resolveMemoryRoot(cwd, config)));
  if (!existsSync(filePath)) return;
  const db = await openMemoryDb({ filePath });
  try {
    const repo = new MemoryIndexRepository(db);
    for (const p of paths) repo.deleteFileByPath(p);
  } finally {
    db.close();
  }
}

/** Remove one entry and, in the same critical section, its rows in the sqlite search index. */
export async function removeFactAndForget(
  cwd: string,
  id: string,
  config?: MemoryLocationConfig,
): Promise<boolean> {
  const touched = await removeFactEntry(cwd, id, config, (paths) =>
    forgetIndexedFiles(cwd, paths, config),
  );
  return touched.length > 0;
}
