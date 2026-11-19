import { readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MemoryFactAmbiguousError, MemoryFactNotRemovableError } from "../../../errors.js";
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
  return entries;
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
 * same mutex; `beforeRemove` runs inside it, before anything is deleted. For a per-memory file the
 * index line is rewritten atomically first and the file unlinked second, so an interruption between
 * the two leaves a still-listed file that a retry with the same id removes. Resolves the absolute
 * paths it changed, or `[]` when no entry has the id, and throws {@link MemoryFactNotRemovableError}
 * when the entry exists only outside the write root.
 */
export function removeFactEntry(
  cwd: string,
  id: string,
  config?: MemoryLocationConfig,
  beforeRemove?: (touched: string[]) => Promise<void>,
): Promise<string[]> {
  const writeRoot = resolveMemoryRoot(cwd, config);
  return withCwdMutex(writeRoot, async () => {
    const target = await findRemovable(cwd, id, config, writeRoot);
    if (target === undefined) return [];
    return removeTarget(writeRoot, target, beforeRemove);
  });
}

async function removeTarget(
  writeRoot: string,
  target: FactEntry,
  beforeRemove?: (touched: string[]) => Promise<void>,
): Promise<string[]> {
  const memoryMd = join(writeRoot, "MEMORY.md");
  const file = join(writeRoot, target.id);
  const touched = target.legacy ? [memoryMd] : [file, memoryMd];
  // Index cleanup first: if it fails nothing is removed and the same call can be retried; if a
  // later step fails the index merely lacks rows that the next sync re-adds.
  await beforeRemove?.(touched);
  if (target.legacy) return (await removeLegacyBullet(writeRoot, target.fact.text)) ? touched : [];
  // Index line before the unlink: if the unlink fails, the file is still listed and a retry by
  // id finishes the job.
  await removeIndexLine(writeRoot, target.id);
  await unlink(file);
  return touched;
}

/** The write-root entry with `id`; undefined when none; throws when it exists only elsewhere. */
async function findRemovable(
  cwd: string,
  id: string,
  config: MemoryLocationConfig | undefined,
  writeRoot: string,
): Promise<FactEntry | undefined> {
  const matches = (await allFactEntries(cwd, config)).filter((e) => e.id === id);
  if (matches.length === 0) return undefined;
  assertSingleRoot(id, matches);
  const target = matches.find((e) => resolve(e.root) === resolve(writeRoot));
  if (target === undefined)
    throw new MemoryFactNotRemovableError(id, (matches[0] as FactEntry).root);
  return target;
}

/** Refuse an id that names entries in more than one root. */
function assertSingleRoot(id: string, matches: FactEntry[]): void {
  const roots = [...new Set(matches.map((e) => resolve(e.root)))];
  if (roots.length > 1) throw new MemoryFactAmbiguousError(id, roots);
}

/**
 * Drop the one `MEMORY.md` index entry (`- [title](file) — hook`) that points at `file`. Only a
 * bullet that is exactly an index entry counts, so a prose bullet that merely links to the file is
 * left alone; a match outside `## Facts` wins over one inside it.
 */
async function removeIndexLine(dir: string, file: string): Promise<void> {
  const raw = await unlessMissing(readFile(join(dir, "MEMORY.md"), "utf8"));
  if (raw === undefined) return;
  const facts = factsBlockRange(raw);
  const lines = raw.split("\n");
  let offset = 0;
  const hits: { at: number; inFacts: boolean }[] = [];
  lines.forEach((line, at) => {
    const start = offset;
    offset += line.length + 1;
    if (!line.startsWith("- ") || !isIndexEntryFor(line.slice(2), file)) return;
    hits.push({ at, inFacts: facts !== undefined && start >= facts.start && start < facts.end });
  });
  // Prefer a line outside `## Facts`; inside it only when nothing else matches, because the
  // writer appends its index line at the end of the file, which can be within a trailing section.
  const at = (hits.find((h) => !h.inFacts) ?? hits[hits.length - 1])?.at ?? -1;
  if (at === -1) return;
  lines.splice(at, 1);
  await replaceFileAtomic(join(dir, "MEMORY.md"), lines.join("\n"));
}

function isIndexEntryFor(body: string, file: string): boolean {
  return INDEX_ENTRY.test(body) && body.includes(`](${file})`);
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
