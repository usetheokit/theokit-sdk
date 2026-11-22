/**
 * Parser for `.theokit/rules/*.md` — theokit-native path-scoped rules,
 * mirroring Claude Code's `.claude/rules/`.
 *
 * Frontmatter fields:
 *  - `paths` — glob-pattern array (Claude Code parity: `.claude/rules` uses `paths:`).
 *  - `globs` — glob-pattern array (Cursor-compatible alias; unioned with `paths`).
 *  - `alwaysApply` — activate unconditionally (no scope needed).
 *  - `enabled` — set `false` to disable the rule entirely (wins over everything).
 *  - `description` — human note; not used for activation in v1.
 *
 * Activation (`shouldActivateRule`):
 *  - `enabled: false` → never activates.
 *  - `alwaysApply: true` → always activates.
 *  - otherwise → activates iff a `paths`/`globs` pattern matches an in-scope
 *    file (the caller's `agent.send(..., { contextPaths })`). With no in-scope
 *    files, a scoped rule stays dormant (parity with Cursor `.mdc`).
 *
 * A file with no `---` frontmatter is treated as an unconditional rule
 * (`alwaysApply: true`). Malformed YAML → `undefined` (caller drops + counts).
 *
 * Glob + YAML subset are shared with the MDC parser (DRY, no new dependency).
 *
 * NOTE — no internal-visibility tag in this block. `tsconfig.base.json` sets `stripInternal: true`,
 * and TypeScript scans EVERY leading comment range of the declaration that follows, including the
 * import right below this one. The tag that used to sit here deleted that import from the emitted
 * `.d.ts`, leaving the types it binds unresolvable for any consumer running type-aware lint
 * (usetheodev/theokit-sdk#283 records the same trap on a declaration).
 */

import { z } from "zod";

import { anyGlobMatches } from "./context-glob.js";
import { parseSimpleYaml, splitFrontmatter } from "./context-yaml-lite.js";

/**
 * YAML frontmatter schema for `.theokit/rules/*.md` files.
 *
 * Every field is optional, and unknown keys are dropped rather than rejected — `safeParse` failing
 * therefore means a declared key had the wrong TYPE (`paths` as a bare string, `enabled` as the
 * string `"false"`), never that an unexpected key was present.
 *
 * Exported because {@link RulesFrontmatter} is inferred from it and appears in the signature of
 * {@link shouldActivateRule}, which `@theokit/sdk/context` publishes: the constant has to reach the
 * emitted declarations for that inferred type to resolve in a consumer's project.
 */
export const RulesFrontmatterSchema = z.object({
  description: z.string().optional(),
  paths: z.array(z.string()).optional(),
  globs: z.array(z.string()).optional(),
  alwaysApply: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export type RulesFrontmatter = z.infer<typeof RulesFrontmatterSchema>;

export interface RulesParseResult {
  readonly frontmatter: RulesFrontmatter;
  readonly body: string;
}

/**
 * Split a `.theokit/rules/*.md` document into its frontmatter and its body.
 *
 * A file with no `---` fence is not an error: the whole text becomes the body and the frontmatter
 * is synthesised as `{ alwaysApply: true }`, so a plain markdown rule with no metadata applies
 * unconditionally. That default is the one thing to know before adding a fence — adding one and
 * omitting both `alwaysApply` and a path pattern turns an always-on rule into a dormant one.
 *
 * `undefined` means the fence was there and its contents did not survive: YAML the lite parser
 * could not read, or a shape the schema rejected (`paths` as a bare string rather than a list,
 * `enabled` as `"false"` rather than `false`). It never throws, and it does not say WHICH of the
 * two happened — the caller drops the file and counts it.
 *
 * Unknown frontmatter keys are dropped rather than rejected, so a misspelled `alwaysAply` parses
 * fine and simply has no effect.
 *
 * Nothing here decides whether the rule applies; that is `shouldActivateRule`.
 *
 * @public — re-exported from `@theokit/sdk/context`, and therefore under semver.
 */
export function parseRules(content: string): RulesParseResult | undefined {
  const { yaml, body } = splitFrontmatter(content);
  if (yaml === undefined) {
    return { frontmatter: { alwaysApply: true }, body: content };
  }
  try {
    const parsed = parseSimpleYaml(yaml);
    const validated = RulesFrontmatterSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    return { frontmatter: validated.data, body };
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a parsed rule applies to this turn, given the files in scope.
 *
 * Checked in strict order, first match wins:
 *
 *   1. `enabled: false` — never applies, whatever else the frontmatter says. This overrides
 *      `alwaysApply: true`, which is the point of having it.
 *   2. `alwaysApply: true` — applies, and `inScopePaths` is not consulted.
 *   3. otherwise — applies only if some pattern from `paths` or `globs` matches some path in
 *      `inScopePaths`. The two lists are a union, not alternatives; `globs` exists for
 *      Cursor compatibility and behaves identically.
 *
 * A scoped rule with an EMPTY `inScopePaths` never applies. That is the case worth planning for:
 * `contextPaths` is empty on a plain `agent.send()`, so a rule scoped by path stays dormant until
 * the caller declares which files the turn is about. It is quiet — a dormant rule looks exactly
 * like a rule that was never written.
 *
 * A rule with a fence but no patterns and no `alwaysApply` also never applies, since step 3 has
 * nothing to match.
 *
 * `description` is not consulted. It is a note for humans, not an activation condition.
 *
 * @public — re-exported from `@theokit/sdk/context`, and therefore under semver.
 */
export function shouldActivateRule(
  fm: RulesFrontmatter,
  inScopePaths: ReadonlyArray<string>,
): boolean {
  if (fm.enabled === false) return false;
  if (fm.alwaysApply === true) return true;
  const patterns = [...(fm.paths ?? []), ...(fm.globs ?? [])];
  if (patterns.length === 0) return false;
  return anyGlobMatches(patterns, inScopePaths);
}
