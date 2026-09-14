/**
 * V4A patch format — Codex's `apply_patch` grammar (`*** Begin Patch` … `*** End Patch`).
 *
 * A faithful TypeScript reimplementation of the Codex `apply-patch` crate (parser + seek_sequence matcher
 * + apply), with ONE deliberate hardening: the apply is STRICT — the whole plan (every new file content +
 * path check) is computed first, and only if all succeed is anything written. A mismatch/error anywhere
 * ⇒ typed error, zero writes (Codex writes file-by-file and can leave partial writes on an IO error).
 *
 * Grammar:
 *   *** Begin Patch / *** End Patch                  envelope (markers matched after trim; CRLF stripped)
 *   *** Add File: <path>    then `+`lines            create (strip one `+`; always trailing newline)
 *   *** Delete File: <path>                          delete
 *   *** Update File: <path>  (*** Move to: <path>)?   update (+ optional rename)
 *     change chunks: `@@` | `@@ <ctx>` then lines:
 *       ` `=context (old+new)  `+`=add (new)  `-`=remove (old)   optional `*** End of File`
 */

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARK = "*** End of File";
const CTX = "@@ ";
const CTX_EMPTY = "@@";

export type V4AHunk =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath: string | null; chunks: V4AChunk[] };

export interface V4AChunk {
  context: string | null;
  oldLines: string[];
  newLines: string[];
  eof: boolean;
}

export class V4APatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V4APatchError";
  }
}

/**
 * Why the marker was not found, in terms the writer can act on.
 *
 * The flat message — `missing '*** Begin Patch'` — is true about the exact match and misleading
 * about the text: a patch opening with `*** Begin Patch ***` contains that string, so the reader is
 * sent looking for an absent line while the problem is three characters at the end of a line that is
 * right there.
 *
 * Measured 2026-09-13 on a live run: a model wrote the symmetric form by analogy with the
 * `*** Add File: …` headers, burned three attempts against this message, and abandoned the step.
 *
 * The variant is NOT accepted. V4A is a format other tools also parse, and quietly widening it here
 * would make a patch this runtime writes unreadable elsewhere — so the error teaches the exact
 * spelling instead.
 */
function missingBeginMessage(lines: readonly string[]): string {
  const nearMiss = lines.find((l) => {
    const t = l.trim();
    return t !== BEGIN && t.startsWith(BEGIN);
  });
  if (nearMiss === undefined) return `Invalid patch: missing '${BEGIN}'`;
  return (
    `Invalid patch: the opening marker must be exactly '${BEGIN}', and this patch has ` +
    `'${nearMiss.trim()}'. Drop everything after '${BEGIN}' on that line — the trailing '***' ` +
    `belongs to no marker in this format.`
  );
}

/** Parse a V4A patch string into hunks. Throws {@link V4APatchError} on any structural problem. */
export function parseV4A(patch: string): V4AHunk[] {
  const lines = patch.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  let i = 0;
  while (i < lines.length && lines[i]!.trim() !== BEGIN) i++;
  if (i >= lines.length) throw new V4APatchError(missingBeginMessage(lines));
  i++; // consume Begin Patch

  const hunks: V4AHunk[] = [];
  while (i < lines.length) {
    if (lines[i]!.trim() === END) return hunks;
    const step = parseNextHunk(lines, i);
    if (step.hunk) hunks.push(step.hunk);
    i = step.next;
  }
  throw new V4APatchError("Invalid patch: missing '*** End Patch'");
}

/** Dispatch on the hunk-header at `i`. Returns the parsed hunk (or none, for a blank line) + next index. */
function parseNextHunk(lines: string[], i: number): { hunk?: V4AHunk; next: number } {
  const line = lines[i]!;
  if (line.startsWith(ADD)) {
    const [hunk, next] = parseAdd(lines, i);
    return { hunk, next };
  }
  if (line.startsWith(DELETE)) {
    return { hunk: { kind: "delete", path: line.slice(DELETE.length).trim() }, next: i + 1 };
  }
  if (line.startsWith(UPDATE)) {
    const [hunk, next] = parseUpdate(lines, i);
    return { hunk, next };
  }
  if (line.trim() === "") return { next: i + 1 }; // tolerate blank lines between hunks
  throw new V4APatchError(`Invalid patch hunk on line ${i + 1}: unexpected '${line}'`);
}

function parseAdd(lines: string[], start: number): [V4AHunk, number] {
  const path = lines[start]!.slice(ADD.length).trim();
  let i = start + 1;
  const body: string[] = [];
  while (i < lines.length && lines[i]!.startsWith("+")) {
    body.push(lines[i]!.slice(1));
    i++;
  }
  // Every added line (incl. the last) is followed by a newline ⇒ file always ends with a trailing newline.
  const content = body.length > 0 ? `${body.join("\n")}\n` : "";
  return [{ kind: "add", path, content }, i];
}

function parseUpdate(lines: string[], start: number): [V4AHunk, number] {
  const path = lines[start]!.slice(UPDATE.length).trim();
  let i = start + 1;
  let movePath: string | null = null;
  if (i < lines.length && lines[i]!.startsWith(MOVE)) {
    movePath = lines[i]!.slice(MOVE.length).trim();
    i++;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (isHunkBoundary(line)) break;
    cur = feedLine(chunks, cur, line, path, i + 1);
  }
  pushChunk(chunks, cur, path);
  if (chunks.length === 0) throw new V4APatchError(`Update file hunk for '${path}' is empty`);
  return [{ kind: "update", path, movePath, chunks }, i];
}

function isHunkBoundary(line: string): boolean {
  return (
    line.trim() === END ||
    line.startsWith(ADD) ||
    line.startsWith(DELETE) ||
    line.startsWith(UPDATE)
  );
}

function emptyChunk(): V4AChunk {
  return { context: null, oldLines: [], newLines: [], eof: false };
}

/** Push a completed chunk (rejecting an empty change block), or no-op when there is no current chunk. */
function pushChunk(chunks: V4AChunk[], cur: V4AChunk | null, path: string): void {
  if (!cur) return;
  if (cur.oldLines.length === 0 && cur.newLines.length === 0) {
    throw new V4APatchError(`Update hunk for '${path}' has an empty change block`);
  }
  chunks.push(cur);
}

/** Route one line inside an Update hunk: a `@@` marker starts a chunk, `*** End of File` flags eof,
 *  everything else is a change line. Returns the current chunk. */
function feedLine(
  chunks: V4AChunk[],
  cur: V4AChunk | null,
  line: string,
  path: string,
  lineNum: number,
): V4AChunk {
  if (line === CTX_EMPTY || line.startsWith(CTX)) {
    pushChunk(chunks, cur, path);
    return {
      context: line === CTX_EMPTY ? null : line.slice(CTX.length),
      oldLines: [],
      newLines: [],
      eof: false,
    };
  }
  if (line.trim() === EOF_MARK) {
    if (!cur) throw new V4APatchError(`'*** End of File' before any change in '${path}'`);
    cur.eof = true;
    return cur;
  }
  return appendChangeLine(cur, line, path, lineNum);
}

/** Classify a `+`add / `-`remove / ` `|empty context line into the chunk. */
function appendChangeLine(
  cur: V4AChunk | null,
  line: string,
  path: string,
  lineNum: number,
): V4AChunk {
  const c = cur ?? emptyChunk();
  if (line.startsWith("+")) {
    c.newLines.push(line.slice(1));
    return c;
  }
  if (line.startsWith("-")) {
    c.oldLines.push(line.slice(1));
    return c;
  }
  if (line === "" || line.startsWith(" ")) {
    const content = line === "" ? "" : line.slice(1); // bare empty line = empty context line
    c.oldLines.push(content);
    c.newLines.push(content);
    return c;
  }
  throw new V4APatchError(
    `Unexpected line in update hunk for '${path}' (line ${lineNum}): every line must start with ' ', '+', or '-': '${line}'`,
  );
}

// --- Matching: the seek_sequence ladder (exact → rstrip → trim → unicode) ---

const UNICODE_MAP: Record<string, string> = {
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  " ": " ",
  " ": " ",
  " ": " ",
};
function normalise(s: string): string {
  let out = "";
  for (const ch of s) out += UNICODE_MAP[ch] ?? ch;
  return out.trim();
}

const LADDER: Array<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.replace(/\s+$/, "") === b.replace(/\s+$/, ""),
  (a, b) => a.trim() === b.trim(),
  (a, b) => normalise(a) === normalise(b),
];

function matchesAt(
  lines: string[],
  pattern: string[],
  at: number,
  eq: (a: string, b: string) => boolean,
): boolean {
  for (let k = 0; k < pattern.length; k++) {
    if (!eq(lines[at + k]!, pattern[k]!)) return false;
  }
  return true;
}

/** First index ≥ searchStart where `pattern` matches `lines` under increasing leniency; null if none.
 *  `eof` forces the search to start at the tail. Mirrors Codex `seek_sequence`. */
export function seekSequence(
  lines: string[],
  pattern: string[],
  searchStart: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return searchStart;
  if (pattern.length > lines.length) return null;
  // `eof` is a HINT: prefer a match anchored at the tail, but fall back to a general forward search —
  // otherwise a last-line edit fails, because `"a\nb\n".split("\n")` has a phantom trailing "" that
  // pushes the tail anchor one past the real last line.
  const starts = eof
    ? [Math.max(searchStart, lines.length - pattern.length), searchStart]
    : [searchStart];
  for (const start of starts) {
    const hit = searchFrom(lines, pattern, start);
    if (hit !== null) return hit;
  }
  return null;
}

/** Scan `lines` from `start` under the leniency ladder; the first matching index, or null. */
function searchFrom(lines: string[], pattern: string[], start: number): number | null {
  for (const eq of LADDER) {
    for (let i = start; i <= lines.length - pattern.length; i++) {
      if (matchesAt(lines, pattern, i, eq)) return i;
    }
  }
  return null;
}

/** Apply an update hunk's chunks to file content (forward cursor, sequential). Throws on a context/region miss. */
export function applyUpdateChunks(content: string, path: string, chunks: V4AChunk[]): string {
  const lines = content.split("\n");
  // Collect (start, oldLen, newLines) forward-only, then splice descending so indices stay valid.
  const edits: Array<{ start: number; oldLen: number; newLines: string[] }> = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== null) {
      const ctxAt = seekSequence(lines, [chunk.context], cursor, false);
      if (ctxAt === null) {
        throw new V4APatchError(`Failed to find context '${chunk.context}' in ${path}`);
      }
      cursor = ctxAt + 1;
    }
    const at = seekSequence(lines, chunk.oldLines, cursor, chunk.eof);
    if (at === null) {
      throw new V4APatchError(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
      );
    }
    edits.push({ start: at, oldLen: chunk.oldLines.length, newLines: chunk.newLines });
    cursor = at + chunk.oldLines.length;
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    lines.splice(e.start, e.oldLen, ...e.newLines);
  }
  return lines.join("\n");
}
