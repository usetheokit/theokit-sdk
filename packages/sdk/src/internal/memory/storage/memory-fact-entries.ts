import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MemoryFactNotRemovableError } from "../../../errors.js";
import { replaceFileAtomic } from "../../persistence/atomic-write.js";
import { withCwdMutex } from "../../persistence/cwd-mutex.js";
import {
  type FactEntry,
  factsBlockRange,
  INDEX_ENTRY,
  readLegacyEntriesIn,
  readMemoryEntriesIn,
  unlessMissing,
} from "./markdown-store.js";
import { type MemoryLocationConfig, memoryReadRoots, resolveMemoryRoot } from "./memory-root.js";

/** What {@link listFactEntries} reports for one stored memory. */
export interface FactEntryInfo {
  id: string;
  text: string;
  modified?: string;
  root: string;
  removable: boolean;
}

async function allFactEntries(cwd: string, config?: MemoryLocationConfig): Promise<FactEntry[]> {
  const roots = memoryReadRoots(cwd, config);
  const entries: FactEntry[] = [];
  // Same two passes, same order, as readFactsFromMarkdown.
  for (const dir of roots) entries.push(...(await readMemoryEntriesIn(dir)));
  for (const dir of roots) entries.push(...(await readLegacyEntriesIn(dir)));
  // A file name is only unique inside its root. Outside the write root the id carries the root, so
  // two roots holding a same-named file never share an id.
  const writeRoot = resolve(resolveMemoryRoot(cwd, config));
  return entries.map((e) =>
    e.legacy || resolve(e.root) === writeRoot ? e : { ...e, id: `${rootTag(e.root)}:${e.id}` },
  );
}

function rootTag(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12);
}

/**
 * Every stored memory with an id, in the order {@link readFactsFromMarkdown} returns them.
 * `removable` is true only for entries under the write root.
 */
export async function listFactEntries(
  cwd: string,
  config?: MemoryLocationConfig,
): Promise<FactEntryInfo[]> {
  const writeRoot = resolve(resolveMemoryRoot(cwd, config));
  return (await allFactEntries(cwd, config)).map((e) => ({
    id: e.id,
    text: e.fact.text,
    ...(e.fact.modified !== undefined ? { modified: e.fact.modified } : {}),
    root: e.root,
    removable: resolve(e.root) === writeRoot,
  }));
}

/**
 * Remove one stored memory from the write root: the per-memory file and its `MEMORY.md` index
 * line, or one legacy bullet inside `## Facts`. Serialized with {@link appendFactToMarkdown} on the
 * same mutex; both files are written atomically. Resolves the removed fact's text, or `undefined`
 * when no entry has the id, and throws {@link MemoryFactNotRemovableError} when the entry exists
 * only outside the write root.
 */
export function removeFactEntry(
  cwd: string,
  id: string,
  config?: MemoryLocationConfig,
): Promise<string | undefined> {
  const writeRoot = resolveMemoryRoot(cwd, config);
  return withCwdMutex(writeRoot, async () => {
    const matches = (await allFactEntries(cwd, config)).filter((e) => e.id === id);
    if (matches.length === 0) return undefined;
    const target = matches.find((e) => resolve(e.root) === resolve(writeRoot));
    if (target === undefined)
      throw new MemoryFactNotRemovableError(id, (matches[0] as FactEntry).root);
    if (target.legacy)
      return (await removeLegacyBullet(writeRoot, target.fact.text)) ? target.fact.text : undefined;
    await unlink(join(writeRoot, target.id));
    await removeIndexLine(writeRoot, target.id);
    return target.fact.text;
  });
}

/** Drop the `MEMORY.md` line that links to `file`, if the index has one. */
async function removeIndexLine(dir: string, file: string): Promise<void> {
  const raw = await unlessMissing(readFile(join(dir, "MEMORY.md"), "utf8"));
  if (raw === undefined) return;
  const lines = raw.split("\n");
  const kept = lines.filter((l) => !l.startsWith("- [") || !l.includes(`](${file})`));
  if (kept.length !== lines.length)
    await replaceFileAtomic(join(dir, "MEMORY.md"), kept.join("\n"));
}

/** Remove the first bullet inside `## Facts` whose text is `text`; lines elsewhere are untouched. */
async function removeLegacyBullet(dir: string, text: string): Promise<boolean> {
  const raw = await unlessMissing(readFile(join(dir, "MEMORY.md"), "utf8"));
  const range = raw === undefined ? undefined : factsBlockRange(raw);
  if (raw === undefined || range === undefined) return false;
  let offset = range.start;
  for (const line of raw.slice(range.start, range.end).split("\n")) {
    const lineEnd = offset + line.length;
    const t = line.trim();
    if (t.startsWith("- ") && t.slice(2).trim() === text && !INDEX_ENTRY.test(text)) {
      const cut = raw.slice(0, offset) + raw.slice(Math.min(lineEnd + 1, raw.length));
      await replaceFileAtomic(join(dir, "MEMORY.md"), cut);
      return true;
    }
    offset = lineEnd + 1;
  }
  return false;
}
