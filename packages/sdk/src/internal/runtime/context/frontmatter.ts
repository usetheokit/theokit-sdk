/**
 * The one `---` frontmatter splitter and scalar-YAML parser behind every markdown loader.
 *
 * @internal
 */
import { ConfigurationError } from "../../../errors.js";

export interface FrontmatterSplit {
  /** Text between the fences; undefined when the file has no opening fence. */
  readonly yaml: string | undefined;
  readonly body: string;
}

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

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function parseScalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (raw !== "" && Number.isFinite(n) && raw === String(n)) return n;
  return unquote(raw);
}

function parseValue(raw: string): FrontmatterScalar {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
  }
  return parseScalar(raw);
}

function isSkippable(trimmed: string): boolean {
  return trimmed === "" || trimmed.startsWith("#");
}

/** Collect the `- item` lines after a bare `key:`; returns the items and the next index. */
function collectList(lines: string[], start: number): { items: string[]; end: number } {
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
  const out: Record<string, FrontmatterScalar> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const trimmed = (lines[i] ?? "").trim();
    i += 1;
    if (isSkippable(trimmed)) continue;
    const colon = trimmed.indexOf(":");
    const key = colon === -1 ? "" : trimmed.slice(0, colon).trim();
    if (key === "") throw invalid(lineNo, trimmed);
    const rest = trimmed.slice(colon + 1).trim();
    if (rest !== "") {
      out[key] = parseValue(rest);
      continue;
    }
    const list = collectList(lines, i);
    out[key] = list.items;
    i = list.end;
  }
  return out;
}
