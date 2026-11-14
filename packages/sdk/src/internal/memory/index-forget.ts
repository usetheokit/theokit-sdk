import { existsSync } from "node:fs";

import { defaultIndexPath, openMemoryDb } from "./index-db.js";
import { MemoryIndexRepository } from "./index-repository.js";
import {
  type MemoryLocationConfig,
  memoryIndexRoot,
  resolveMemoryRoot,
} from "./storage/memory-root.js";

/**
 * Drop the sqlite search index's rows for files whose content a fact removal changed, so a removed
 * fact is not recalled before the next sync. A changed `MEMORY.md` is re-chunked by that sync. No
 * index file means nothing to drop. The Lance backend is not reached: its ids are content hashes
 * with no link to a file.
 *
 * @internal
 */
export async function forgetIndexedFiles(
  cwd: string,
  paths: ReadonlyArray<string>,
  config?: MemoryLocationConfig,
): Promise<void> {
  if (paths.length === 0) return;
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
