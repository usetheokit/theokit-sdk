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

import { type FrontmatterScalar, parseFrontmatterEntries } from "./frontmatter.js";

export type FrontmatterValue = FrontmatterScalar;

/**
 * Loader flavour of {@link parseFrontmatterEntries}: quotes kept, bare `key:` is `undefined`, and a
 * line with no `key:` is skipped rather than rejected.
 */
export function parseSimpleYaml(text: string): Record<string, FrontmatterValue | undefined> {
  return parseFrontmatterEntries(text, { keepQuotes: true, bareKeyUndefined: true, lenient: true });
}
