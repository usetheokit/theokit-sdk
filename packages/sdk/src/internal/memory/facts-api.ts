import { forgetIndexedFiles } from "./index-forget.js";
import {
  type FactEntryInfo,
  listFactEntries,
  removeFactEntry,
} from "./storage/memory-fact-entries.js";
import type { MemoryLocationConfig } from "./storage/memory-root.js";

export { type FactEntryInfo, listFactEntries };

/** Remove one entry, then drop its rows from the sqlite search index. Whether anything went. */
export async function removeFactAndForget(
  cwd: string,
  id: string,
  config?: MemoryLocationConfig,
): Promise<boolean> {
  const touched = await removeFactEntry(cwd, id, config);
  await forgetIndexedFiles(cwd, touched, config);
  return touched.length > 0;
}
