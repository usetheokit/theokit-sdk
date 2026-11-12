import { createHash } from "node:crypto";

import type { MemoryChunk } from "../types.js";

/**
 * Split a markdown document into semantically meaningful chunks (ADR D1 of
 * memory-system-peer-project-parity).
 *
 * Algorithm:
 *   1. Walk lines tracking the current heading (latest `^#+ ` line).
 *   2. Split chunks at the next heading boundary AND on blank-line paragraph
 *      boundaries.
 *   3. If a single paragraph exceeds `maxChars`, split it at the nearest
 *      whitespace ≤ maxChars (word-aligned per edge-case review EC-6) —
 *      never mid-word.
 *
 * Mirrors peer-project's `chunkMarkdown` from
 * `packages/memory-host-sdk/src/host/chunk-markdown.ts`.
 *
 */

export interface ChunkMarkdownOptions {
  /** Maximum chars per chunk. Default 800. */
  maxChars?: number;
  /** Minimum chars per chunk (avoids splintering tiny lines). Default 80. */
  minChars?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

interface ChunkAccumulator {
  chunks: MemoryChunk[];
  lines: string[];
  start: number;
  heading: string | undefined;
}

export function chunkMarkdown(text: string, options: ChunkMarkdownOptions = {}): MemoryChunk[] {
  const maxChars = options.maxChars ?? 800;
  if (text.length === 0) return [];
  const lines = text.split("\n");
  const acc: ChunkAccumulator = { chunks: [], lines: [], start: 1, heading: undefined };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;
    processLine(acc, line, lineNumber, maxChars);
  }
  flushAccumulator(acc, lines.length, maxChars);
  return acc.chunks;
}

function processLine(
  acc: ChunkAccumulator,
  line: string,
  lineNumber: number,
  maxChars: number,
): void {
  const headingMatch = HEADING_RE.exec(line);
  const isBlank = line.trim().length === 0;
  if (headingMatch !== null && acc.lines.length > 0) {
    flushAccumulator(acc, lineNumber - 1, maxChars);
  }
  if (headingMatch !== null) acc.heading = headingMatch[2];
  acc.lines.push(line);
  if (isBlank && acc.lines.length > 1) {
    const joined = acc.lines.join("\n");
    if (joined.trim().length > 0) flushAccumulator(acc, lineNumber, maxChars);
  }
}

function flushAccumulator(acc: ChunkAccumulator, endLineExclusive: number, maxChars: number): void {
  if (acc.lines.length === 0) return;
  const chunkText = acc.lines.join("\n");
  if (chunkText.trim().length === 0) {
    acc.lines = [];
    acc.start = endLineExclusive + 1;
    return;
  }
  if (chunkText.length > maxChars) {
    pushOversizedSlices(acc.chunks, chunkText, acc.start, acc.heading, maxChars);
  } else {
    acc.chunks.push(buildChunk(chunkText, acc.start, endLineExclusive, acc.heading));
  }
  acc.lines = [];
  acc.start = endLineExclusive + 1;
}

function buildChunk(
  text: string,
  startLine: number,
  endLine: number,
  heading: string | undefined,
): MemoryChunk {
  return {
    startLine,
    endLine,
    text,
    hash: createHash("sha256").update(text).digest("hex"),
    ...(heading !== undefined ? { heading } : {}),
  };
}

function pushOversizedSlices(
  chunks: MemoryChunk[],
  text: string,
  startLine: number,
  heading: string | undefined,
  maxChars: number,
): void {
  let remaining = text;
  let lineCursor = startLine;
  while (remaining.length > maxChars) {
    const splitAt = findWordBoundarySplit(remaining, maxChars);
    const slice = remaining.slice(0, splitAt);
    const sliceLines = slice.split("\n").length;
    chunks.push(buildChunk(slice, lineCursor, lineCursor + sliceLines - 1, heading));
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
    lineCursor += sliceLines - 1;
  }
  if (remaining.length > 0) {
    const sliceLines = remaining.split("\n").length;
    chunks.push(buildChunk(remaining, lineCursor, lineCursor + sliceLines - 1, heading));
  }
}

/**
 * Find a split point ≤ maxChars that lands on a whitespace boundary so we
 * don't slice a word in half. Falls back to maxChars if no whitespace is
 * within range (very rare — a single token > maxChars).
 */
function findWordBoundarySplit(text: string, maxChars: number): number {
  if (text.length <= maxChars) return text.length;
  // Walk backward from maxChars looking for whitespace.
  for (let i = maxChars; i > Math.max(0, maxChars - 200); i--) {
    if (/\s/.test(text[i] ?? "x")) return i;
  }
  // No whitespace within 200 chars of the cap — accept a hard split.
  return maxChars;
}
