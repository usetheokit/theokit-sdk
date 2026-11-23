import { existsSync } from "node:fs";
import { syncCorpus } from "../corpus-sync.js";
import { defaultIndexPath, openMemoryDb } from "../index-db.js";
import { MemoryIndexRepository } from "../index-repository.js";
import { appendFactToMarkdown } from "./markdown-store.js";
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

/** Drop an entry's sqlite index rows, then remove it, in one critical section. */
export async function removeFactAndForget(
  cwd: string,
  id: string,
  config?: MemoryLocationConfig,
): Promise<boolean> {
  const touched = await removeFactEntry(cwd, id, config, (paths) =>
    forgetIndexedFiles(cwd, paths, config),
  );
  if (touched.length === 0) return false;
  await reindexMemoryDir(cwd, config);
  return true;
}

/**
 * Re-walk the write root so the edited `MEMORY.md` is indexed again without the removed fact; its
 * other facts must stay recallable. Files that left the disk are dropped by the same walk.
 */
async function reindexMemoryDir(cwd: string, config?: MemoryLocationConfig): Promise<void> {
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

/** Append a fact to the write root for `config` (honours `directory`, `userId`, `maxFacts`). */
export async function addFact(
  cwd: string,
  text: string,
  config?: MemoryLocationConfig & { maxFacts?: number },
): Promise<void> {
  await appendFactToMarkdown(
    cwd,
    { text },
    resolveMemoryRoot(cwd, config),
    config?.maxFacts === undefined ? {} : { maxFacts: config.maxFacts },
  );
  await reindexMemoryDir(cwd, config);
}
