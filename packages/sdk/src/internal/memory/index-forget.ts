import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { syncCorpus } from "./corpus-sync.js";
import { defaultIndexPath, openMemoryDb } from "./index-db.js";
import { MemoryIndexRepository } from "./index-repository.js";
import { lanceStoragePath } from "./lance-index.js";
import {
  type MemoryLocationConfig,
  memoryIndexRoot,
  resolveMemoryRoot,
} from "./storage/memory-root.js";

/**
 * Make the search indexes forget a fact a removal just took off disk, so recall does not return it.
 *
 * - sqlite: the corpus is re-walked ({@link syncCorpus}), so a deleted per-memory file leaves the
 *   index and an edited `MEMORY.md` is re-chunked in place; the other facts in it stay searchable.
 *   Vectors for chunks that were not re-embedded are filled in by the next `IndexManager.sync()`.
 * - Lance: rows whose `text` equals the fact's are deleted from the `facts` table. Lance ids are
 *   hashes with no link to a file, so the text is the only handle. Opening the table needs no
 *   embedding runtime.
 *
 * Absent index or absent `@lancedb/lancedb` means there is nothing to drop.
 *
 * @internal
 */
export async function forgetIndexedFacts(
  cwd: string,
  text: string,
  config?: MemoryLocationConfig,
): Promise<void> {
  const root = resolveMemoryRoot(cwd, config);
  await forgetInSqlite(cwd, root, config);
  await forgetInLance(root, text);
}

async function forgetInSqlite(
  cwd: string,
  root: ReturnType<typeof resolveMemoryRoot>,
  _config?: MemoryLocationConfig,
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

interface LanceTableLike {
  delete: (predicate: string) => Promise<void>;
}
interface LanceLike {
  connect: (uri: string) => Promise<{
    tableNames: () => Promise<string[]>;
    openTable: (name: string) => Promise<LanceTableLike>;
  }>;
}

async function forgetInLance(
  root: ReturnType<typeof resolveMemoryRoot>,
  text: string,
): Promise<void> {
  const path = lanceStoragePath(root);
  if (!existsSync(path)) return;
  let lance: LanceLike;
  try {
    lance = createRequire(import.meta.url)("@lancedb/lancedb") as LanceLike;
  } catch {
    return; // not installed: no Lance table this process could have written
  }
  const conn = await lance.connect(path);
  if (!(await conn.tableNames()).includes("facts")) return;
  const table = await conn.openTable("facts");
  // Same escaping as LanceIndex's predicates; a newline inside a quoted literal is legal SQL.
  const literal = text.replace(/\\/g, "\\\\").replace(/'/g, "''");
  await table.delete(`text = '${literal}'`);
}
