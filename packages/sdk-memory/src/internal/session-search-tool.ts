/**
 * `session_search` — word-match recall over the turns of earlier sessions (#1556).
 *
 * `memory_search({ corpus: "sessions" })` reads the summary written when a session ends; this reads
 * the turns themselves, from the native `.jsonl` transcripts the SDK already stores. A record is
 * searchable only when it carries a `memoryPartition` equal to the tool's `partition` (the agent's
 * `memory.userId`), so one sender cannot read another's turns. Records written before the stamp
 * existed carry no partition and are never returned.
 *
 * The SDK uses the agent id as the transcript's session id, so `sessionKey` is that id.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { MemoryTool } from "./tools.js";

export interface SessionSearchToolOptions {
  /** Directory holding the transcripts; searched recursively for `.jsonl` files. */
  transcriptsDir: string;
  /** The memory partition (`memory.userId`) whose turns may be returned. */
  partition: string;
  /** A session to leave out of the results, usually the one the tool runs in. */
  excludeSessionId?: string;
  /** Largest number of hits a call returns. Default 5. */
  maxResults?: number;
}

export interface SessionSearchHit {
  sessionKey: string;
  /** ISO time the turn was recorded. */
  at: string;
  role: "user" | "assistant";
  text: string;
  /** Number of distinct query words found in the turn. */
  score: number;
}

interface IndexedTurn {
  sessionKey: string;
  at: string;
  role: "user" | "assistant";
  text: string;
  words: ReadonlySet<string>;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  turns: IndexedTurn[];
}

const MAX_TEXT_CHARS = 1000;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

async function jsonlFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return jsonlFiles(p);
      return e.isFile() && e.name.endsWith(".jsonl") ? [p] : [];
    }),
  );
  return nested.flat();
}

function turnOf(line: string, partition: string): IndexedTurn | undefined {
  let rec: {
    type?: string;
    sessionId?: string;
    timestamp?: string;
    memoryPartition?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (rec.memoryPartition !== partition) return undefined;
  if (rec.type !== "user" && rec.type !== "assistant") return undefined;
  if (typeof rec.sessionId !== "string" || typeof rec.timestamp !== "string") return undefined;
  const text = (rec.message?.content ?? [])
    .flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
    .join("\n");
  if (text.length === 0) return undefined;
  return {
    sessionKey: rec.sessionId,
    at: rec.timestamp,
    role: rec.type,
    text,
    words: new Set(wordsOf(text)),
  };
}

async function indexFile(path: string, partition: string): Promise<IndexedTurn[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\n").flatMap((l) => {
    const t = l.length > 0 ? turnOf(l, partition) : undefined;
    return t === undefined ? [] : [t];
  });
}

function scoreTurn(t: IndexedTurn, q: ReadonlySet<string>): SessionSearchHit | undefined {
  let score = 0;
  for (const w of q) if (t.words.has(w)) score++;
  if (score === 0) return undefined;
  return {
    sessionKey: t.sessionKey,
    at: t.at,
    role: t.role,
    text: t.text.slice(0, MAX_TEXT_CHARS),
    score,
  };
}

export interface SessionSearchTool extends MemoryTool {
  search(query: string, maxResults?: number): Promise<SessionSearchHit[]>;
}

/**
 * Build the `session_search` tool. Files are re-indexed only when their size or mtime changes, and
 * only turns of `partition` are kept in memory; a deleted file drops out of the cache.
 */
export function sessionSearchTool(opts: SessionSearchToolOptions): SessionSearchTool {
  const cache = new Map<string, CachedFile>();
  const limit = opts.maxResults ?? 5;

  async function reindex(p: string): Promise<void> {
    try {
      const st = await stat(p);
      const hit = cache.get(p);
      if (hit?.mtimeMs === st.mtimeMs && hit.size === st.size) return;
      const turns = await indexFile(p, opts.partition);
      cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, turns });
    } catch {
      cache.delete(p);
    }
  }

  async function refresh(): Promise<IndexedTurn[]> {
    const files = await jsonlFiles(opts.transcriptsDir);
    const live = new Set(files);
    for (const p of cache.keys()) if (!live.has(p)) cache.delete(p);
    for (const p of files) await reindex(p);
    return [...cache.values()].flatMap((c) => c.turns);
  }

  async function search(query: string, maxResults = limit): Promise<SessionSearchHit[]> {
    const q = new Set(wordsOf(query));
    if (q.size === 0) return [];
    const hits = (await refresh())
      .filter((t) => t.sessionKey !== opts.excludeSessionId)
      .flatMap((t) => scoreTurn(t, q) ?? []);
    hits.sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : -1));
    return hits.slice(0, Math.max(0, maxResults));
  }

  return {
    name: "session_search",
    description:
      "Search what was said in earlier sessions (other surfaces or days) by word match. Returns { sessionKey, at, role, text, score } turns, best match first.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Words to look for in earlier turns." },
        maxResults: { type: "number", description: "Largest number of turns to return." },
      },
    },
    search,
    async execute(input) {
      const query = input.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        throw new Error("query is required");
      }
      const n = typeof input.maxResults === "number" ? input.maxResults : undefined;
      return JSON.stringify({ hits: await search(query, n) });
    },
  };
}
