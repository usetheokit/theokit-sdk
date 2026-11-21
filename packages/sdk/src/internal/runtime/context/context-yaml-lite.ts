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
 * Both this and `yaml-frontmatter.ts` are thin dialects over `parseYamlSubset` in `frontmatter.ts`.
 *
 * @internal
 */

import { ConfigurationError } from "../../../errors.js";
import {
  type FrontmatterSplit,
  parseYamlSubset,
  splitFrontmatter as splitFences,
} from "./frontmatter.js";

export type { FrontmatterSplit };

/**
 * Split `---`-fenced frontmatter from the body. When no frontmatter fence is present, or the fence
 * is never closed, `yaml` is undefined and `body` is the whole content.
 *
 * @internal
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  try {
    return splitFences(content);
  } catch (error) {
    if (error instanceof ConfigurationError && error.code === "frontmatter_unterminated") {
      return { yaml: undefined, body: content };
    }
    throw error;
  }
}

/**
 * Parse the minimal YAML subset. Throws `frontmatter_invalid` on a line without a colon.
 *
 * @internal
 */
export function parseSimpleYaml(yaml: string): Record<string, unknown> {
  return parseYamlSubset(yaml, { rich: true });
}
