/**
 * The one `---` frontmatter splitter and scalar-YAML parser behind every markdown loader.
 *
 * @internal
 */
import { ConfigurationError } from "../../../errors.js";

/** The two halves of a markdown file: the text between the `---` fences, and everything after. */
export interface FrontmatterSplit {
  /** Text between the fences; undefined when the file has no opening fence. */
  readonly yaml: string | undefined;
  readonly body: string;
}

/** A value the frontmatter YAML subset can carry: string, number, boolean or string list. */
export type FrontmatterScalar = string | number | boolean | string[];

const FENCE = "---";

function isFence(line: string | undefined): boolean {
  return line !== undefined && line.trimEnd() === FENCE;
}

/**
 * Split `---`-fenced frontmatter from the body. CRLF-safe (line endings are normalised to `\n`).
 *
 * @throws ConfigurationError code `frontmatter_unterminated` when an opening fence has no closing one.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (!isFence(lines[0])) return { yaml: undefined, body: raw };
  for (let i = 1; i < lines.length; i += 1) {
    if (isFence(lines[i])) {
      return { yaml: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  throw new ConfigurationError("Frontmatter has an opening `---` fence but no closing one", {
    code: "frontmatter_unterminated",
  });
}

/**
 * Loader-compat switches for {@link parseFrontmatterEntries}. The default (all false) is the public
 * {@link parseFrontmatterYaml} behaviour.
 *
 * @internal
 */
export interface FrontmatterParseOptions {
  /** Keep quotes on values (`match: "1"` stays the 3-char string), as the file loaders always did. */
  readonly keepQuotes?: boolean;
  /** A bare `key:` with no list items is `undefined` (so a caller's Zod default applies), not `[]`. */
  readonly bareKeyUndefined?: boolean;
  /** Skip a line without a usable `key:` instead of throwing `frontmatter_invalid`. */
  readonly lenient?: boolean;
}

function unquoter(opts: FrontmatterParseOptions): (s: string) => string {
  return opts.keepQuotes ? (s) => s : (s) => s.replace(/^["']|["']$/g, "");
}

function parseValue(raw: string, unquote: (s: string) => string): FrontmatterScalar {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (raw !== "" && Number.isFinite(n) && raw === String(n)) return n;
  return unquote(raw);
}

function isSkippable(trimmed: string): boolean {
  return trimmed === "" || trimmed.startsWith("#");
}

/** Collect the `- item` lines after a bare `key:`; returns the items and the next index. */
function collectList(
  lines: string[],
  start: number,
  unquote: (s: string) => string,
): { items: string[]; end: number } {
  const items: string[] = [];
  let j = start;
  for (; j < lines.length; j += 1) {
    const t = (lines[j] ?? "").trim();
    if (isSkippable(t)) continue;
    if (!t.startsWith("- ")) break;
    items.push(unquote(t.slice(2).trim()));
  }
  return { items, end: j };
}

function splitEntry(trimmed: string): { key: string; rest: string } | undefined {
  const colon = trimmed.indexOf(":");
  const key = colon === -1 ? "" : trimmed.slice(0, colon).trim();
  return key === "" ? undefined : { key, rest: trimmed.slice(colon + 1).trim() };
}

function skipOrThrow(opts: FrontmatterParseOptions, lineNo: number, text: string): void {
  if (!opts.lenient) throw invalid(lineNo, text);
}

function bareValue(items: string[], opts: FrontmatterParseOptions): string[] | undefined {
  return items.length === 0 && opts.bareKeyUndefined ? undefined : items;
}

function invalid(lineNo: number, text: string): ConfigurationError {
  return new ConfigurationError(`Invalid frontmatter YAML at line ${lineNo}: ${text}`, {
    code: "frontmatter_invalid",
  });
}

/**
 * Parse the YAML subset the loaders accept: `key: scalar`, `key: [a, b]`, and `key:` followed by
 * `- item` lines. A bare `key:` with no items is `[]`.
 *
 * @throws ConfigurationError code `frontmatter_invalid` naming the 1-based line number.
 */
export function parseFrontmatterYaml(yaml: string): Record<string, FrontmatterScalar> {
  return parseFrontmatterEntries(yaml, {}) as Record<string, FrontmatterScalar>;
}

/**
 * The parser behind {@link parseFrontmatterYaml}, with the switches the file loaders need to keep
 * their historical value shapes.
 *
 * @internal
 */
export function parseFrontmatterEntries(
  yaml: string,
  opts: FrontmatterParseOptions,
): Record<string, FrontmatterScalar | undefined> {
  const unquote = unquoter(opts);
  const out: Record<string, FrontmatterScalar | undefined> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const trimmed = (lines[i] ?? "").trim();
    i += 1;
    if (isSkippable(trimmed)) continue;
    const entry = splitEntry(trimmed);
    if (entry === undefined) {
      skipOrThrow(opts, lineNo, trimmed);
      continue;
    }
    if (entry.rest !== "") {
      out[entry.key] = parseValue(entry.rest, unquote);
      continue;
    }
    const list = collectList(lines, i, unquote);
    out[entry.key] = bareValue(list.items, opts);
    i = list.end;
  }
  return out;
}
