/**
 * The corpus walk: read every markdown file under the memory root, and re-chunk the ones that
 * changed.
 *
 * One of the four concerns that shared `IndexManager`, and the one with the most distinct reason to
 * change — "which files are in the corpus and when is one stale" is a question about the filesystem,
 * not about search or about the schema. It takes a {@link MemoryIndexRepository} rather than a
 * database, so it cannot reach past it into SQL.
 *
 * The staleness test is the content hash, NOT the mtime. mtime is written into `files` for
 * observability; a file touched without being edited must not cost a re-chunk, and a file restored
 * from a backup with an older mtime must not be skipped.
 *
 * @internal
 */

import { readFile, stat } from "node:fs/promises";
import { collectMarkdownFiles, sha256 } from "./index-manager-helpers.js";
import type { MemoryIndexRepository } from "./index-repository.js";
import { chunkMarkdown } from "./storage/chunk-markdown.js";
import type { MemoryRoot } from "./storage/memory-root.js";

export interface CorpusSyncCounts {
  readonly filesScanned: number;
  readonly filesUpdated: number;
  readonly chunksWritten: number;
}

export async function syncCorpus(
  repo: MemoryIndexRepository,
  memoryRoot: MemoryRoot,
): Promise<CorpusSyncCounts> {
  const files = await collectMarkdownFiles(memoryRoot);
  const existingByPath = repo.filesByPath();
  let filesUpdated = 0;
  let chunksWritten = 0;

  for (const entry of files) {
    const raw = await readFile(entry.absolutePath, "utf8");
    const hash = sha256(raw);
    if (existingByPath.get(entry.absolutePath)?.hash === hash) continue;

    const stats = await stat(entry.absolutePath);
    const fileId = repo.upsertFile({
      absPath: entry.absolutePath,
      relPath: entry.relPath,
      hash,
      mtimeMs: stats.mtimeMs,
      source: entry.source,
    });
    repo.deleteChunksForFile(fileId);
    const chunks = chunkMarkdown(raw);
    for (const chunk of chunks) repo.insertChunk({ fileId, ...chunk });

    filesUpdated += 1;
    chunksWritten += chunks.length;
  }

  // A file that left the disk must leave the index, or its chunks stay searchable forever.
  const onDisk = new Set(files.map((f) => f.absolutePath));
  for (const path of existingByPath.keys()) if (!onDisk.has(path)) repo.deleteFileByPath(path);

  return { filesScanned: files.length, filesUpdated, chunksWritten };
}
