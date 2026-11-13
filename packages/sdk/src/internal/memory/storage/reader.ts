import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { MemoryReadResult } from "../types.js";

/**
 * Bounded read with truncation info (ADR D5 — `memory_get` foundation).
 *
 * Mirrors peer-project's `buildMemoryReadResult` semantics:
 * - `from` is 1-indexed.
 * - `lines` defaults to 200 (`DEFAULT_MEMORY_READ_LINES`).
 * - Returns up to EOF when the requested slice extends past file end.
 * - Sets `truncated: true` when fewer lines were returned than requested AND
 *   there's still content past the slice. (At EOF, `truncated: false`.)
 *
 */

export const DEFAULT_MEMORY_READ_LINES = 200;

export interface ReadFileOptions {
  cwd: string;
  relPath: string;
  from?: number;
  lines?: number;
}

export async function readMemoryFileBounded(opts: ReadFileOptions): Promise<MemoryReadResult> {
  const absolutePath = resolvePath(opts.cwd, opts.relPath);
  const raw = await readFile(absolutePath, "utf8");
  const allLines = raw.split("\n");
  // Strip a trailing empty line caused by a final \n so totalLines reflects
  // the editor-visible line count, not the byte-level split.
  const trimmedLines =
    allLines.length > 0 && allLines[allLines.length - 1] === "" ? allLines.slice(0, -1) : allLines;
  const totalLines = trimmedLines.length;

  const requestedFrom = Math.max(1, opts.from ?? 1);
  const requestedLines = Math.max(1, opts.lines ?? DEFAULT_MEMORY_READ_LINES);
  const startIdx = requestedFrom - 1;
  const endIdx = Math.min(totalLines, startIdx + requestedLines);
  const slice = trimmedLines.slice(startIdx, endIdx);
  const linesReturned = slice.length;
  const remainingLines = Math.max(0, totalLines - endIdx);
  // truncated = "more content exists past the returned slice"
  const truncated = remainingLines > 0;

  return {
    path: opts.relPath,
    from: requestedFrom,
    linesReturned,
    totalLines,
    truncated,
    remainingLines,
    text: slice.join("\n"),
  };
}
