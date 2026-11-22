/**
 * The one `---` frontmatter splitter and scalar-YAML parser every markdown loader goes through.
 *
 * Re-exported from `@theokit/sdk/context`. Line-oriented on purpose (no regex over the whole
 * file): CRLF and LF are normalised up front, so fences are found by comparing whole lines.
 */
import { ConfigurationError } from "../../../errors.js";

export interface FrontmatterSplit {
  /** Text between the fences; undefined when the file has no opening fence. */
  readonly yaml: string | undefined;
  readonly body: string;
}

export type FrontmatterScalar = string | number | boolean | string[];

const FENCE = "---";

/**
 * Split `---` frontmatter from the body. The opening fence is `---` on the first line; the closing
 * fence is `---` on its own line and may be the last line of the file. `\r\n` and `\n` both work.
 *
 * Throws `ConfigurationError` code `frontmatter_unterminated` when an opening fence has no closing
 * one. With no opening fence, `yaml` is undefined and `body` is the input unchanged.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if ((lines[0] ?? "").trimEnd() !== FENCE) return { yaml: undefined, body: raw };
  const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === FENCE);
  if (close === -1) {
    throw new ConfigurationError(
      "Frontmatter opened with `---` on the first line but has no closing `---` line",
      { code: "frontmatter_unterminated" },
    );
  }
  return { yaml: lines.slice(1, close).join("\n"), body: lines.slice(close + 1).join("\n") };
}

/**
 * Parse the YAML subset the loaders accept: `key: scalar` (string, number, boolean), inline
 * `[a, b]` lists and `key:` followed by `- item` lines. A bare `key:` with no items is omitted.
 * Blank and `#` lines are skipped. Throws `ConfigurationError` code `frontmatter_invalid`, naming
 * the 1-based line, on a line that is not `key: value`.
 */
export function parseFrontmatterYaml(yaml: string): Record<string, FrontmatterScalar> {
  const out: Record<string, FrontmatterScalar> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? "").trim();
    if (text === "" || text.startsWith("#")) continue;
    const { key, raw } = splitEntry(text, i + 1);
    if (raw !== "") {
      out[key] = coerce(raw);
      continue;
    }
    const block = collectBlockList(lines, i + 1);
    if (block.items.length > 0) out[key] = block.items;
    i = block.end - 1;
  }
  return out;
}

function splitEntry(text: string, lineNo: number): { key: string; raw: string } {
  const colon = text.indexOf(":");
  const key = colon === -1 ? "" : text.slice(0, colon).trim();
  if (key === "") {
    throw new ConfigurationError(`Invalid frontmatter at line ${lineNo}: expected \`key: value\``, {
      code: "frontmatter_invalid",
    });
  }
  return { key, raw: text.slice(colon + 1).trim() };
}

function collectBlockList(lines: string[], start: number): { items: string[]; end: number } {
  const items: string[] = [];
  let j = start;
  for (; j < lines.length; j += 1) {
    const next = (lines[j] ?? "").trim();
    if (next === "" || next.startsWith("#")) continue;
    if (!next.startsWith("- ")) break;
    items.push(next.slice(2).trim());
  }
  return { items, end: j };
}

function coerce(raw: string): FrontmatterScalar {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (raw === "true" || raw === "false") return raw === "true";
  const n = Number(raw);
  if (Number.isFinite(n) && raw === String(n)) return n;
  return raw;
}
