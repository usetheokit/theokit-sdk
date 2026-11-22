/**
 * Compatibility adapter over {@link parseFrontmatterYaml} (frontmatter.ts), used by the file-based loaders (skills,
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

import { parseFrontmatterYaml } from "./frontmatter.js";

export type FrontmatterValue = string | number | boolean | string[];

export function parseSimpleYaml(text: string): Record<string, FrontmatterValue | undefined> {
  return parseFrontmatterYaml(keepEntryLines(text));
}

/**
 * These loaders have always skipped lines that are not `key: value` (a folded `description: >`
 * continuation, stray prose) where the shared parser throws. Drop them here so no file that loaded
 * before starts failing. A `- item` line survives only straight after a bare `key:` or another item.
 */
function keepEntryLines(text: string): string {
  const kept: string[] = [];
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) {
      kept.push(line);
      continue;
    }
    const colon = t.indexOf(":");
    if (colon > 0 && t.slice(0, colon).trim() !== "") {
      inList = t.slice(colon + 1).trim() === "";
      kept.push(line);
    } else if (inList && t.startsWith("- ")) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}
