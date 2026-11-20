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
 * How the loaders' dialects differ. The defaults are the public {@link parseFrontmatterYaml}.
 *
 * @internal
 */
export interface YamlDialect {
  /** Skip a line with no usable `key:` instead of throwing `frontmatter_invalid`. */
  readonly lenient?: boolean;
  /** Keep surrounding quotes on scalars and inline/block list items. */
  readonly keepQuotes?: boolean;
  /** A bare `key:` with no items is `undefined` rather than `[]`. */
  readonly bareKeyUndefined?: boolean;
  /**
   * Rule-file dialect: indented `k: v` lines under a bare key form a nested map, integers only
   * (no floats), and list items are scalar-coerced.
   */
  readonly rich?: boolean;
}

type Item = string | number | boolean;

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function parseScalar(raw: string, d: YamlDialect): Item {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (d.rich === true) {
    if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  } else {
    const n = Number(raw);
    if (raw !== "" && Number.isFinite(n) && raw === String(n)) return n;
  }
  return d.keepQuotes === true ? raw : unquote(raw);
}

function parseItem(raw: string, d: YamlDialect): Item {
  if (d.rich === true) return parseScalar(unquote(raw), d);
  return d.keepQuotes === true ? raw : unquote(raw);
}

function parseValue(raw: string, d: YamlDialect): unknown {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseItem(s, d));
  }
  return parseScalar(raw, d);
}

function isSkippable(trimmed: string): boolean {
  return trimmed === "" || trimmed.startsWith("#");
}

interface Collected {
  readonly items: Item[];
  readonly nested: Record<string, Item>;
  readonly end: number;
}

/** The `k: v` pair on an indented line under a bare key (rich dialect only), if it is one. */
function nestedEntry(line: string, t: string, d: YamlDialect): [string, Item] | undefined {
  if (d.rich !== true || !/^\s/.test(line) || !t.includes(":")) return undefined;
  const c = t.indexOf(":");
  return [t.slice(0, c).trim(), parseScalar(t.slice(c + 1).trim(), d)];
}

/** Collect what follows a bare `key:`: `- item` lines, or (rich dialect) indented `k: v` lines. */
function collectBlock(lines: string[], start: number, d: YamlDialect): Collected {
  const items: Item[] = [];
  const nested: Record<string, Item> = {};
  let j = start;
  for (; j < lines.length; j += 1) {
    const line = lines[j] ?? "";
    const t = line.trim();
    if (isSkippable(t)) continue;
    const entry = nestedEntry(line, t, d);
    if (t.startsWith("- ")) items.push(parseItemValue(t.slice(2).trim(), d));
    else if (entry !== undefined) nested[entry[0]] = entry[1];
    else break;
  }
  return { items, nested, end: j };
}

function parseItemValue(item: string, d: YamlDialect): Item {
  return d.rich === true ? parseScalar(item, d) : parseItem(item, d);
}

function invalid(lineNo: number, text: string): ConfigurationError {
  return new ConfigurationError(`Invalid YAML at line ${lineNo}: ${text}`, {
    code: "frontmatter_invalid",
  });
}

/** Split a line into key and raw value; undefined when it has no usable `key:`. */
function splitEntry(trimmed: string): { key: string; rest: string } | undefined {
  const colon = trimmed.indexOf(":");
  const key = colon === -1 ? "" : trimmed.slice(0, colon).trim();
  return key === "" ? undefined : { key, rest: trimmed.slice(colon + 1).trim() };
}

/** The value of a bare `key:` and the index to resume at. */
function bareKeyValue(
  lines: string[],
  start: number,
  d: YamlDialect,
): { value: unknown; next: number } {
  const block = collectBlock(lines, start, d);
  if (Object.keys(block.nested).length > 0) return { value: block.nested, next: block.end };
  if (block.items.length === 0 && d.bareKeyUndefined === true) {
    return { value: undefined, next: start };
  }
  return { value: block.items, next: block.end };
}

/** The value after `key:` (inline, or the block below a bare key) and the index to resume at. */
function entryValue(
  rest: string,
  lines: string[],
  next: number,
  d: YamlDialect,
): { value: unknown; next: number } {
  return rest === "" ? bareKeyValue(lines, next, d) : { value: parseValue(rest, d), next };
}

/**
 * The one YAML-subset engine; the loaders differ only in the {@link YamlDialect} they pass.
 *
 * @internal
 * @throws ConfigurationError code `frontmatter_invalid` naming the 1-based line number (unless lenient).
 */
export function parseYamlSubset(yaml: string, d: YamlDialect = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? "").trim();
    i += 1;
    if (isSkippable(trimmed)) continue;
    const entry = splitEntry(trimmed);
    if (entry === undefined) {
      if (d.lenient === true) continue;
      throw invalid(i, trimmed);
    }
    const read = entryValue(entry.rest, lines, i, d);
    out[entry.key] = read.value;
    i = read.next;
  }
  return out;
}

/**
 * Parse the YAML subset the loaders accept: `key: scalar`, `key: [a, b]`, and `key:` followed by
 * `- item` lines. A bare `key:` with no items is `[]`.
 *
 * @throws ConfigurationError code `frontmatter_invalid` naming the 1-based line number.
 */
export function parseFrontmatterYaml(yaml: string): Record<string, FrontmatterScalar> {
  return parseYamlSubset(yaml) as Record<string, FrontmatterScalar>;
}
