import { existsSync } from "node:fs";

import { syncCorpus } from "../corpus-sync.js";
import { defaultIndexPath, openMemoryDb } from "../index-db.js";
import { MemoryIndexRepository } from "../index-repository.js";
import { type FactEntryInfo, listFactEntries, removeFactEntry } from "./memory-fact-entries.js";
import { type MemoryLocationConfig, memoryIndexRoot, resolveMemoryRoot } from "./memory-root.js";

export { type FactEntryInfo, listFactEntries };

/**
 * Drop the sqlite search index's rows for the changed files. Runs under the store's mutex before the
 * entry is removed, so a failure leaves the entry in place and the removal can be retried.
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

/**
 * Re-chunk the files the removal edited. The rows were dropped before the removal so a failure
 * left the entry in place; this puts back the chunks of what remains (the other facts in
 * `MEMORY.md`), so they stay searchable. Embeddings for them are added by the next full sync.
 */
async function reindexAfterRemoval(cwd: string, config?: MemoryLocationConfig): Promise<void> {
  const writeRoot = resolveMemoryRoot(cwd, config);
  const filePath = defaultIndexPath(memoryIndexRoot(cwd, writeRoot));
  if (!existsSync(filePath)) return;
  const db = await openMemoryDb({ filePath });
  try {
    await syncCorpus(new MemoryIndexRepository(db), writeRoot);
  } finally {
    db.close();
  }
}

/** Drop an entry's sqlite index rows, remove it, then re-chunk what is left of the edited files. */
export async function removeFactAndForget(
  cwd: string,
  id: string,
  config?: MemoryLocationConfig,
): Promise<boolean> {
  const touched = await removeFactEntry(cwd, id, config, (paths) =>
    forgetIndexedFiles(cwd, paths, config),
  );
  if (touched.length === 0) return false;
  await reindexAfterRemoval(cwd, config);
  return true;
}
