import { forgetIndexedFacts } from "../index-forget.js";
import { type FactEntryInfo, listFactEntries, removeFactEntry } from "./memory-fact-entries.js";
import type { MemoryLocationConfig } from "./memory-root.js";

export { type FactEntryInfo, listFactEntries };

/** Remove one entry, then drop it from the search indexes. Whether anything went. */
export async function removeFactAndForget(
  cwd: string,
  id: string,
  config?: MemoryLocationConfig,
): Promise<boolean> {
  const text = await removeFactEntry(cwd, id, config);
  if (text === undefined) return false;
  await forgetIndexedFacts(cwd, text, config);
  return true;
}
