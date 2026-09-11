/**
 * Tiny YAML-frontmatter parser shared by the file-based loaders (skills,
 * subagents, hooks, context, plugins). Supports four scalar shapes:
 *
 *   key: bar              → "bar"        (string)
 *   key: 42               → 42           (number)
 *   key: true             → true         (boolean)
 *   key: [a, b, c]        → ["a","b","c"](string[])
 *   key:                  → undefined    (caller's Zod default kicks in)
 *     - a                 → ["a","b"]    (block list, when `- ` items follow a bare key)
 *     - b
 *
 * Limitations (intentional — keep parser tiny, no dep):
 * - No nested objects (use flat keys like `providerId` not `provider.id`).
 * - No quoted strings — `match: "1"` becomes the literal 3-char string `"1"`.
 * - Inline list values cannot contain a literal comma inside an element; the
 *   `tags: [a,b, c]` splitter is greedy on `,`. Use the block form above or
 *   reword if you need this — and note that the block form was, for a while,
 *   what this line recommended and the parser could not read.
 *
 * @internal
 */

export type FrontmatterValue = string | number | boolean | string[];

export function parseSimpleYaml(text: string): Record<string, FrontmatterValue | undefined> {
  const fields: Record<string, FrontmatterValue | undefined> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const entry = splitEntry(lines[i] ?? "");
    if (entry === undefined) continue;
    const { key, raw } = entry;

    // `key:` with nothing after it may open a block list. Collect first, then decide: items found →
    // a list; none → `undefined`, which is the long-standing meaning of a bare key and what a
    // caller's Zod default relies on.
    const block = raw.length === 0 ? collectBlockList(lines, i + 1) : undefined;
    if (block !== undefined && block.items.length > 0) {
      fields[key] = block.items;
      // `end` is the first line that is NOT part of this list, and the loop's own `i += 1` steps
      // past it — so stop one short, or the key after a block list is swallowed.
      i = block.end - 1;
      continue;
    }

    fields[key] = coerce(raw);
  }
  return fields;
}

/**
 * Split one line into its key and its raw value, or report that it carries neither.
 *
 * A line with no `:` is not an entry (a `- item` continuation is the case that matters here), and
 * neither is one whose key is blank. Both were `continue`s inside the loop; they are the same
 * question — "is this line an entry?" — and asking it in one place is what keeps the loop under the
 * repository's cognitive-complexity limit.
 */
function splitEntry(line: string): { key: string; raw: string } | undefined {
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) return undefined;
  const key = line.slice(0, colonIndex).trim();
  if (key.length === 0) return undefined;
  return { key, raw: line.slice(colonIndex + 1).trim() };
}

/**
 * Read the `- item` lines that follow a bare `key:`, and report where they stop.
 *
 * Line-oriented parsing skipped these outright — a `- item` has no colon — so the key coerced to
 * `undefined` and the values went nowhere. A reader saw the key on disk and found no behaviour,
 * with nothing to grep for. The docblock above made it sharper by advising "use multi-line lists"
 * for a limitation of the inline form; multi-line was the one shape this parser could not read.
 *
 * Extracted rather than inlined because inlining it put `parseSimpleYaml` at a cognitive complexity
 * of 24 against a limit of 10 — measured, not assumed: the pre-change function raised no such
 * diagnostic on the same file path.
 *
 * Blank and `#` lines do not end a list; anything else does. `end` is the index of that first
 * non-item line, so the caller resumes there rather than re-reading what it consumed.
 */
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

function coerce(raw: string): FrontmatterValue | undefined {
  // EC-3: empty value → undefined so Zod `.optional().default(...)` applies.
  if (raw.length === 0) return undefined;
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
