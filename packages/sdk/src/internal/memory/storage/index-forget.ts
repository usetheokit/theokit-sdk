import { existsSync } from "node:fs";

import { syncCorpus } from "../corpus-sync.js";
import { defaultIndexPath, openMemoryDb } from "../index-db.js";
import { MemoryIndexRepository } from "../index-repository.js";
import { forgetInLance } from "./lance-forget.js";
import { type MemoryLocationConfig, memoryIndexRoot, resolveMemoryRoot } from "./memory-root.js";

/**
 * Make the search indexes forget a fact a removal just took off disk, so recall does not return it.
 *
 * - sqlite: the corpus is re-walked ({@link syncCorpus}), so a deleted per-memory file leaves the
 *   index and an edited `MEMORY.md` is re-chunked in place; the other facts in it stay searchable.
 *   Vectors for chunks that were not re-embedded are filled in by the next `IndexManager.sync()`.
 * - Lance: see {@link forgetInLance}; the text is the only handle, since Lance rows carry no file.
 *
 * Absent index or absent `@lancedb/lancedb` means there is nothing to drop.
 *
 * @internal
 */
export async function forgetIndexedFacts(
  cwd: string,
  text: string,
  stillStored: boolean,
  config?: MemoryLocationConfig,
): Promise<void> {
  const root = resolveMemoryRoot(cwd, config);
  await forgetInSqlite(cwd, root);
  await forgetInLance(root, text, stillStored);
}

async function forgetInSqlite(
  cwd: string,
  root: ReturnType<typeof resolveMemoryRoot>,
): Promise<void> {
  const filePath = defaultIndexPath(memoryIndexRoot(cwd, root));
  if (!existsSync(filePath)) return;
  const db = await openMemoryDb({ filePath });
  try {
    await syncCorpus(new MemoryIndexRepository(db), root);
  } finally {
    db.close();
  }
}
