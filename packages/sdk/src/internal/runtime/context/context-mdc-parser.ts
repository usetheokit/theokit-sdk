/**
 * MDC (Markdown Cursor) parser for `.cursor/rules/*.mdc` (T3.1, ADR D154).
 *
 * Parses YAML frontmatter with `description` / `globs` / `alwaysApply`
 * fields. Honors activation per Cursor's docs:
 *  - `alwaysApply: true` → activates unconditionally.
 *  - `alwaysApply: false` + matching glob in `touchedFiles` → activates.
 *  - `alwaysApply: false` + no glob match → skipped.
 *
 * **EC-I (v1 semantic):** at `agent.send()` time, `touchedFiles` is empty
 * UNLESS the caller passes `contextPaths` (the in-scope file set). When
 * `contextPaths` is provided, per-glob activation fires; otherwise only
 * `alwaysApply: true` rules activate. Description-based "agent requested"
 * classification is out of scope.
 *
 * Glob matching + the YAML subset are shared with the `.theokit/rules/*.md`
 * parser via `context-glob.ts` / `context-yaml-lite.ts` (DRY, no new dep).
 *
 * @internal
 */

import { z } from "zod";

import { anyGlobMatches } from "./context-glob.js";
import { parseSimpleYaml, splitFrontmatter } from "./context-yaml-lite.js";

/** YAML frontmatter schema for MDC files. @internal */
export const McdFrontmatterSchema = z.object({
  description: z.string().optional(),
  globs: z.array(z.string()).optional(),
  alwaysApply: z.boolean().optional(),
});

export type McdFrontmatter = z.infer<typeof McdFrontmatterSchema>;

export interface McdParseResult {
  readonly frontmatter: McdFrontmatter;
  readonly body: string;
}

/**
 * Parse `.mdc` content. Returns frontmatter + body. EC-18: when the
 * file has no `---` frontmatter, returns `frontmatter: {alwaysApply:
 * true}` so the body is treated as an unconditional rule.
 *
 * On YAML parse error, returns `undefined` and the caller emits a
 * telemetry counter (EC-21).
 *
 * @internal
 */
export function parseMdc(content: string): McdParseResult | undefined {
  const { yaml, body } = splitFrontmatter(content);
  if (yaml === undefined) {
    // EC-18: no frontmatter — treat as alwaysApply
    return { frontmatter: { alwaysApply: true }, body: content };
  }
  try {
    const parsed = parseSimpleYaml(yaml);
    const validated = McdFrontmatterSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    return { frontmatter: validated.data, body };
  } catch {
    return undefined;
  }
}

/**
 * Decide whether an MDC rule activates given the currently-touched
 * files. EC-I: empty `touchedFiles` → only `alwaysApply: true`
 * activates.
 *
 * @internal
 */
export function shouldActivate(fm: McdFrontmatter, touchedFiles: ReadonlyArray<string>): boolean {
  if (fm.alwaysApply === true) return true;
  if (fm.globs === undefined || fm.globs.length === 0) return false;
  return anyGlobMatches(fm.globs, touchedFiles);
}
