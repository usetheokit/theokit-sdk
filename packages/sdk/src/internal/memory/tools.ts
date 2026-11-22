import { resolve as resolvePath } from "node:path";

import { ConfigurationError } from "../../errors.js";
import { atOrInsideRoot } from "../security/path-containment.js";
import type { MemorySearchHit } from "./index-manager.js";
import type { MemoryIndex } from "./memory-index.js";
import type { MemoryRoot } from "./storage/memory-root.js";
import { readMemoryFileBounded } from "./storage/reader.js";

/**
 * Memory tools (`memory_search` + `memory_get`) — ADR D5 of
 * memory-system-peer-project-parity. Tool schemas mirror peer-project
 * (`reference/peer-project/extensions/memory-core/src/tools.ts:228-475`).
 *
 * Each tool is exposed as a `MemoryTool` (name + description + JSON schema +
 * async execute). The agent-loop integration wires them via the existing
 * `ResolvedTool` interface in `tool-dispatch.ts`.
 *
 * @internal
 */

export interface MemoryToolJson {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MemoryTool extends MemoryToolJson {
  execute(input: Record<string, unknown>): Promise<string>;
}

const SEARCH_DESCRIPTION =
  "Mandatory recall step: semantically search MEMORY.md + memory/notes/*.md (and optional wiki supplements) before answering questions about prior work, decisions, dates, people, preferences, or todos. `corpus=memory` (default) restricts to indexed memory files; `corpus=wiki` restricts to read-only wiki supplements; `corpus=all` returns both. Returns ranked `{ path, startLine, endLine, score, snippet, citation }` hits.";

const GET_DESCRIPTION =
  "Safe exact excerpt read from MEMORY.md or memory/notes/*.md. Defaults to a bounded excerpt (200 lines). Returns `{ path, from, linesReturned, totalLines, truncated, remainingLines, text }`. Paths are resolved against the memory root — attempts to read outside `.theokit/memory/` are rejected.";

const MEMORY_SEARCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "Natural-language query." },
    maxResults: { type: "integer", minimum: 1, maximum: 50 },
    minScore: { type: "number", minimum: 0, maximum: 1 },
    corpus: { type: "string", enum: ["memory", "sessions", "wiki", "all"] },
  },
  additionalProperties: false,
};

const MEMORY_GET_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", description: "Path relative to .theokit/memory/" },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1, maximum: 2000 },
  },
  additionalProperties: false,
};

const DEFAULT_MAX_TOTAL_CHARS = 16384;

export interface MemorySearchToolOptions {
  index: MemoryIndex;
  /** Cap on the JSON response size (EC-10 of edge-case review). Default 16384. */
  maxTotalChars?: number;
}

export function createMemorySearchTool(opts: MemorySearchToolOptions): MemoryTool {
  const cap = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  return {
    name: "memory_search",
    description: SEARCH_DESCRIPTION,
    inputSchema: MEMORY_SEARCH_SCHEMA,
    async execute(input: Record<string, unknown>): Promise<string> {
      const query = readString(input.query, "query is required");
      const maxResults = readNumber(input.maxResults) ?? 10;
      const minScore = readNumber(input.minScore);
      const corpus = readString(input.corpus, undefined, true);
      const sources = mapCorpusToSources(corpus);
      const searchOptions = {
        maxResults,
        ...(minScore !== undefined ? { minScore } : {}),
        ...(sources !== undefined ? { sources } : {}),
      };
      const hits = await opts.index.search(query, searchOptions);
      return JSON.stringify(capByTotalChars(hits, cap));
    },
  };
}

export interface MemoryGetToolOptions {
  /**
   * The RESOLVED memory root the tool may read inside — not a cwd (#463).
   *
   * This guard used to derive its own root from `cwd` while `appendFact` wrote somewhere else, so
   * a relocated memory was unreadable by the tool whose whole job is reading memory.
   */
  root: MemoryRoot;
}

export function createMemoryGetTool(opts: MemoryGetToolOptions): MemoryTool {
  const memoryRoot = resolvePath(opts.root);
  return {
    name: "memory_get",
    description: GET_DESCRIPTION,
    inputSchema: MEMORY_GET_SCHEMA,
    async execute(input: Record<string, unknown>): Promise<string> {
      const relPath = readString(input.path, "path is required");
      const from = readNumber(input.from);
      const lines = readNumber(input.lines);
      // EC-2: enforce that the resolved path stays inside the memory root.
      const resolved = resolvePath(memoryRoot, relPath);
      if (!isPathInside(memoryRoot, resolved)) {
        throw new ConfigurationError(
          `memory_get rejected path that escapes memory root: ${relPath}`,
          { code: "memory_path_escapes_root" },
        );
      }
      const readArgs: { cwd: string; relPath: string; from?: number; lines?: number } = {
        cwd: memoryRoot,
        relPath,
      };
      if (from !== undefined) readArgs.from = from;
      if (lines !== undefined) readArgs.lines = lines;
      const result = await readMemoryFileBounded(readArgs);
      return JSON.stringify(result);
    },
  };
}

// ───── helpers ──────────────────────────────────────────────────────────

function readString(value: unknown, errorIfMissing?: string, allowUndefined = false): string {
  if (typeof value === "string") return value;
  if (allowUndefined && (value === undefined || value === null)) return "";
  if (errorIfMissing !== undefined) {
    throw new ConfigurationError(errorIfMissing, { code: "memory_tool_bad_args" });
  }
  return "";
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function mapCorpusToSources(
  corpus: string,
): ReadonlyArray<"memory" | "sessions" | "wiki"> | undefined {
  if (corpus === "" || corpus === "all") return undefined;
  if (corpus === "memory") return ["memory"];
  if (corpus === "wiki") return ["wiki"];
  if (corpus === "sessions") return ["sessions"];
  return undefined;
}

function capByTotalChars(
  hits: ReadonlyArray<MemorySearchHit>,
  maxTotalChars: number,
): { hits: MemorySearchHit[]; truncated: boolean } {
  if (hits.length === 0) return { hits: [], truncated: false };
  const kept: MemorySearchHit[] = [];
  let runningChars = 0;
  for (const hit of hits) {
    const snippetLen = hit.snippet.length + (hit.citation?.length ?? 0) + 32; // overhead estimate
    if (kept.length > 0 && runningChars + snippetLen > maxTotalChars) {
      return { hits: kept, truncated: true };
    }
    kept.push(hit);
    runningChars += snippetLen;
  }
  return { hits: kept, truncated: false };
}

/**
 * B-117 — compared after symlink resolution, via the shared rule.
 *
 * The prefix test this replaces judged a link by its NAME: a symlink at `<memoryRoot>/escape`
 * pointing anywhere on disk made `memory_get` read that target, because the path it checked was
 * lexically inside. Measured with a real link before changing it, not deduced.
 *
 * The root itself stays accepted, matching the previous behaviour — `insideRoot` answers false for
 * it, which is right for its own caller and would be a silent behaviour change here.
 */
function isPathInside(root: string, candidate: string): boolean {
  return atOrInsideRoot(candidate, root);
}
