/**
 * `@path/to/file` import resolver (T2.1, ADR D156).
 *
 * Anthropic/Gemini convention: lines that are EXACTLY `@path` get
 * replaced with the imported file's content, recursively (5-hop cap),
 * with cycle detection. Inline `see @x.md, also @y.md` references are
 * NOT resolved (EC-Q — own-line only, mirrors Anthropic's actual
 * behavior).
 *
 * EC-D fix: every imported file is itself capped at `maxBytesPerFile`
 * via `loadPlainMarkdown` BEFORE concatenation. Prevents a CLAUDE.md
 * with 5 imports of 30k each from ballooning to 150k of imported
 * content before the outer cap fires.
 *
 * @internal
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { insideRoot } from "../../security/path-containment.js";
import { loadPlainMarkdown } from "./context-loaders.js";

/** EC-Q: line-anchored. `@path` must be alone on its line. */
const IMPORT_RE = /^@(\S+)\s*$/gm;
const MAX_HOPS = 5;

export interface ResolveImportsOptions {
  /** Absolute paths already resolved (cycle detection). */
  readonly visited: Set<string>;
  /** Current recursion depth — caps at MAX_HOPS. */
  readonly depth: number;
  /** Per-import file cap (EC-D). Forwarded to loadPlainMarkdown. */
  readonly maxBytesPerFile: number;
  /**
   * The directory an import may not escape. When set, a target resolving outside it is
   * refused and replaced with a placeholder.
   *
   * The file carrying the import is REPOSITORY-CONTROLLED — `CLAUDE.md` and `GEMINI.md`
   * are the two default specs with `followImports: true`, and both are found by
   * `git-root-walk` inside the tree the agent was pointed at. Without a root, a cloned
   * repository could name `@~/.ssh/id_rsa` or any absolute path and have its contents
   * inlined into the system prompt, and from there sent to the model provider. The
   * traversal guard that already existed (`isSafePattern`) guards the discovery PATTERN,
   * not the import TARGET, so it never saw this.
   *
   * OPTIONAL, so a caller outside the discovery path keeps the previous behaviour rather
   * than breaking on an upgrade. `runDiscovery` always supplies `gitRoot ?? cwd` — the
   * same value it already uses to keep absolute paths out of `<source name="">`.
   */
  readonly projectRoot?: string;
  /** Paths discovery already emitted; an import naming one gets an "already loaded" placeholder. */
  readonly alreadyLoaded?: ReadonlySet<string>;
  /** Wraps each successfully inlined import (never a placeholder). */
  readonly wrapImport?: (name: string, content: string) => string;
}

/**
 * Resolve `@path` directives in `content`. Each match is replaced with
 * the imported file content (already cap-truncated per EC-D), and
 * recursion continues on the resolved content until MAX_HOPS or cycle.
 *
 * Failure modes (placeholders, never throws):
 *  - file not found → `[@import not found: <path>]`
 *  - cycle detected → `[@import cycle detected: <path>]`
 *  - depth exceeded → trailing `\n\n…[@import depth limit 5 reached]\n\n`
 *
 * @internal
 */
export async function resolveImports(
  content: string,
  basePath: string,
  opts: ResolveImportsOptions,
): Promise<string> {
  if (opts.depth >= MAX_HOPS) {
    return `${content}\n\n…[@import depth limit ${MAX_HOPS} reached]\n\n`;
  }
  const baseDir = dirname(basePath);
  return replaceAsync(content, IMPORT_RE, async (raw) => {
    const absolute = resolveImportPath(raw, baseDir);
    // Containment BEFORE the read. Reporting the refusal after loading the file would
    // already have put the bytes in memory, and the placeholder names the path the author
    // wrote rather than the resolved one — echoing `/home/<user>/.ssh/id_rsa` back into the
    // prompt would leak the layout of the machine to the same untrusted document.
    if (opts.projectRoot !== undefined && !insideRoot(absolute, opts.projectRoot)) {
      return `[@import outside the project root, refused: ${raw}]`;
    }
    const seen = seenPlaceholder(opts, absolute, raw);
    if (seen !== undefined) return seen;
    opts.visited.add(absolute);
    const loaded = await loadPlainMarkdown(absolute, { maxBytesPerFile: opts.maxBytesPerFile });
    if (loaded === undefined) {
      return `[@import not found: ${raw}]`;
    }
    // Recurse with same visited set + incremented depth. `projectRoot` is FORWARDED: an
    // imported file is repository-controlled too, so a root that applied only at depth 0
    // would be escapable in one extra hop.
    const inner = await resolveImports(loaded.content, absolute, {
      ...opts,
      depth: opts.depth + 1,
    });
    return opts.wrapImport === undefined ? inner : opts.wrapImport(raw, inner);
  });
}

/** Placeholder for a target already visited (cycle) or already emitted by discovery. */
function seenPlaceholder(
  opts: ResolveImportsOptions,
  absolute: string,
  raw: string,
): string | undefined {
  if (opts.visited.has(absolute)) return `[@import cycle detected: ${raw}]`;
  if (opts.alreadyLoaded?.has(absolute)) return `[@import already loaded: ${raw}]`;
  return undefined;
}

function resolveImportPath(raw: string, baseDir: string): string {
  if (raw.startsWith("~/")) {
    return resolvePath(join(homedir(), raw.slice(2)));
  }
  if (isAbsolute(raw)) {
    return resolvePath(raw);
  }
  return resolvePath(join(baseDir, raw));
}

/**
 * Async equivalent of `String.prototype.replace` — sequential. Returns
 * `content` with every `re` match replaced by `await replacer(match)`.
 *
 * @internal
 */
async function replaceAsync(
  content: string,
  re: RegExp,
  replacer: (raw: string) => Promise<string>,
): Promise<string> {
  const matches: Array<{ match: string; raw: string; index: number }> = [];
  // Reset lastIndex; clone the regex to avoid stateful traps.
  const localRe = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = localRe.exec(content)) !== null) {
    matches.push({ match: m[0], raw: m[1] ?? "", index: m.index });
    if (m.index === localRe.lastIndex) localRe.lastIndex += 1;
  }
  if (matches.length === 0) return content;
  let result = "";
  let cursor = 0;
  for (const entry of matches) {
    result += content.slice(cursor, entry.index);
    result += await replacer(entry.raw);
    cursor = entry.index + entry.match.length;
  }
  result += content.slice(cursor);
  return result;
}
