/**
 * Minimal YAML-subset frontmatter parsing shared by the `.cursor/rules/*.mdc`
 * and `.theokit/rules/*.md` parsers (extracted for DRY — one parser, one set
 * of edge-case behaviours, no new dependency).
 *
 * Handles `key: value` lines (string scalars, booleans, integers) and `key:`
 * followed by indented `- item` arrays or inline `[a, b]` arrays. Sufficient
 * for the small, fixed frontmatter field sets these rule files use. Throws on
 * a truly malformed line (no colon).
 *
 * NOTE — distinct from the sibling `yaml-frontmatter.ts` `parseSimpleYaml` on
 * purpose: that one parses INLINE arrays only (`key: [a, b]`), whereas rule
 * files (`.cursor/rules/*.mdc`, `.theokit/rules/*.md`) use MULTI-LINE `- item`
 * lists (`paths:` / `globs:`), which this parser adds. Unifying onto the inline
 * parser would drop multi-line list support; unifying the other way would touch
 * the skills/subagents/persistence loaders that depend on the inline one. The
 * two intentionally coexist until a shared parser handles both shapes.
 *
 * @internal
 */

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export interface FrontmatterSplit {
  /** Raw YAML block between the `---` fences, or undefined when absent. */
  readonly yaml: string | undefined;
  /** The markdown body after the frontmatter (or the whole content). */
  readonly body: string;
}

/**
 * Split `---`-fenced frontmatter from the body. When no frontmatter fence is
 * present, `yaml` is undefined and `body` is the whole content.
 *
 * @internal
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const m = FRONTMATTER_RE.exec(content);
  if (m === null) return { yaml: undefined, body: content };
  return { yaml: m[1] ?? "", body: m[2] ?? "" };
}

/**
 * Parse the minimal YAML subset. Throws on a line without a colon (malformed).
 *
 * @internal
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: YAML-subset parser handles scalars + multi-line arrays + inline arrays in a single pass; extracting helpers fragments the line-state machine.
export function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) throw new Error(`Invalid YAML line: ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (rest === "") {
      // `key:` with nothing after it opens either an indented `- item` list or an indented nested
      // map. Which one is decided by the first non-empty indented line, so both are collected here.
      //
      // The map branch is not a new feature so much as a repair: before it, `metadata:` followed by
      // `  type: x` set `metadata` to `[]` AND parsed the indented lines as TOP-LEVEL entries, so
      // the nesting silently flattened and a caller reading `metadata.type` got `undefined` while
      // `type` appeared where it never was. Claude Code's memory files carry exactly that shape.
      const items: string[] = [];
      const nested: Record<string, unknown> = {};
      let sawNested = false;
      while (i < lines.length) {
        const next = lines[i];
        if (next === undefined) break;
        const nextTrim = next.trim();
        if (nextTrim === "") {
          i += 1;
          continue;
        }
        const indented = /^\s/.test(next);
        if (nextTrim.startsWith("- ")) {
          items.push(parseScalar(nextTrim.slice(2).trim()) as string);
          i += 1;
        } else if (indented && nextTrim.includes(":")) {
          const nestedColon = nextTrim.indexOf(":");
          nested[nextTrim.slice(0, nestedColon).trim()] = parseScalar(
            nextTrim.slice(nestedColon + 1).trim(),
          );
          sawNested = true;
          i += 1;
        } else {
          break;
        }
      }
      // An empty `key:` stays `[]` — the pre-existing contract every `paths:` in a rule file relies
      // on. Only an actually-indented `key: value` under it makes it a map.
      out[key] = sawNested ? nested : items;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      // Inline array `globs: ["**/*.ts", "**/*.tsx"]`
      const inner = rest.slice(1, -1).trim();
      out[key] =
        inner === ""
          ? []
          : inner.split(",").map((s) => parseScalar(s.trim().replace(/^["']|["']$/g, "")));
    } else {
      out[key] = parseScalar(rest);
    }
  }
  return out;
}

function parseScalar(s: string): string | boolean | number {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  // Strip surrounding quotes if present.
  return s.replace(/^["']|["']$/g, "");
}
