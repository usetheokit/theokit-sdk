import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ConfigurationError } from "../../../errors.js";
import { assertNoSymlinkEscape, safePathJoin } from "../../security/path-guard.js";
import { readWorkspaceDir } from "../config/workspace-dir.js";
import { parseSkillFrontmatter, stripSkillFrontmatter } from "./skill-frontmatter.js";

/**
 * A discovered skill's metadata. The skill BODY is never included — only the
 * strict frontmatter fields plus the resolved `source` path.
 *
 * Public via `@theokit/sdk/skills`.
 *
 * @public
 */
export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the discovered `SKILL.md`. */
  source: string;
  category?: string;
  dependencies?: string[];
  /** `disable-model-invocation: true` — the model is never told this skill exists. */
  disableModelInvocation?: boolean;
  /** `user-invocable: false` — carried for a host that has a picker; this SDK has no such surface. */
  userInvocable?: boolean;
}

/**
 * Information passed to `onInvalidSkill` when a `SKILL.md` is present but its
 * frontmatter is malformed (missing required field or invalid YAML).
 *
 * @public
 */
export interface InvalidSkillInfo {
  /** The skill directory name (used as the fallback skill name). */
  name: string;
  /** Absolute path to the offending `SKILL.md`. */
  source: string;
  /** Typed reason: `missing_frontmatter` or `schema_invalid`. */
  code: string;
  message: string;
}

/**
 * Options for {@link discoverSkills}.
 *
 * @public
 */
export interface DiscoverSkillsOptions {
  /**
   * Called once per directory that contains a `SKILL.md` with malformed
   * frontmatter. The skill is excluded from the result; discovery continues
   * (strict-frontmatter ADR / EC-5). A directory WITHOUT a `SKILL.md` is NOT a
   * malformed skill and does not trigger this callback.
   *
   * Default: no-op (a library primitive must not write to the consumer's
   * stderr by default).
   */
  onInvalidSkill?: (info: InvalidSkillInfo) => void;
}

/**
 * Discover `SKILL.md` skills under an arbitrary directory.
 *
 * For each immediate subdirectory `<dir>/<name>/` containing a `SKILL.md`, the
 * file's strict YAML frontmatter is parsed (`name`/`description` required;
 * `category`/`dependencies` optional). Malformed skills are skipped (optionally
 * reported via {@link DiscoverSkillsOptions.onInvalidSkill}); a subdirectory
 * whose realpath escapes `dir` (via symlink) is skipped (symlink-escape guard,
 * reusing `@theokit/sdk/path-safety`).
 *
 * NEVER throws: a missing, unreadable, or non-directory `dir` yields `[]`.
 *
 * Discovery order follows the filesystem `readdir` order (OS-dependent). Sort
 * the result before {@link buildSkillsBlock} if a stable block order matters.
 *
 * Public via `@theokit/sdk/skills`.
 *
 * @public
 */
export async function discoverSkills(
  dir: string,
  options?: DiscoverSkillsOptions,
): Promise<Skill[]> {
  let entries: Awaited<ReturnType<typeof readWorkspaceDir>>;
  try {
    entries = await readWorkspaceDir(dir, "skills_read_error", "skills directory");
  } catch {
    // never-throw contract: unreadable / not-a-directory → no skills (EC-1)
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let skillDir: string;
    try {
      skillDir = safePathJoin(dir, entry.name);
      assertNoSymlinkEscape(skillDir, dir);
    } catch {
      continue;
    }
    const skillPath = join(skillDir, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillPath, "utf8");
    } catch {
      // no SKILL.md in this subdir → not a skill, not an error (EC-2)
      continue;
    }
    const skill = tryParseSkill(raw, entry.name, skillPath, options);
    if (skill !== undefined) skills.push(skill);
  }
  return skills;
}

function tryParseSkill(
  raw: string,
  fallbackName: string,
  source: string,
  options: DiscoverSkillsOptions | undefined,
): Skill | undefined {
  try {
    const frontmatter = parseSkillFrontmatter(raw, fallbackName);
    const skill: Skill = {
      name: frontmatter.name,
      description: frontmatter.description,
      source,
    };
    if (frontmatter.category !== undefined) skill.category = frontmatter.category;
    if (frontmatter.dependencies !== undefined) skill.dependencies = frontmatter.dependencies;
    // The authorization flags travel with the record. Dropping them here would reproduce the defect
    // one layer down: the parser would read the declaration and the discovery result would not
    // carry it, which is indistinguishable from never having parsed it.
    if (frontmatter.disableModelInvocation !== undefined) {
      skill.disableModelInvocation = frontmatter.disableModelInvocation;
    }
    if (frontmatter.userInvocable !== undefined) skill.userInvocable = frontmatter.userInvocable;
    return skill;
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      options?.onInvalidSkill?.({
        name: fallbackName,
        source,
        code: cause.code ?? "unknown",
        message: cause.message,
      });
      return undefined;
    }
    throw cause;
  }
}

/**
 * Read the BODY of a discovered skill — everything after its frontmatter.
 *
 * A thin selector over {@link discoverSkills} rather than a second reader, which is the same
 * relationship `loadSubagentDefinition` has to `discoverSubagents` in the sibling domain: one
 * parser is the point.
 *
 * ## Why this exists rather than a field on `Skill`
 *
 * `Skill` documents that *"the skill BODY is never included"*. That is a written contract with no
 * written reason, and widening it on a guess about the reason is not a trade worth making — a
 * catalog you can put in a prompt without carrying every body is the likely intent, and this keeps
 * that shape intact for whoever relied on it.
 *
 * The body was never expensive to obtain: `discoverSkills` already reads each file in full and
 * discards everything but the frontmatter. What was missing was a door that hands it over.
 *
 * ## What it is for
 *
 * Turning a discovered skill into an inline one — `SkillsSettings.inline` requires `instructions`,
 * and without this the only route was to open `source` and split the frontmatter by hand. That is a
 * second implementation of this module's own convention, and it would fail SILENTLY if the format
 * moved: the frontmatter would land inside the instructions and nothing would say so.
 *
 * Reported by the `theocode` session, which needed exactly that to give an operator's
 * `~/.theokit/skills/` to an agent through the SDK's own parser.
 *
 * @param skill - a record returned by {@link discoverSkills}; its `source` is read.
 * @returns the trimmed body. A file that is all frontmatter yields an empty string.
 * @throws if `source` is unreadable — unlike discovery, which skips what it cannot read, a caller
 *   naming ONE skill has asked about that skill and an empty string would answer a question it did
 *   not ask.
 * @public
 */
export async function loadSkillInstructions(skill: Skill): Promise<string> {
  return stripSkillFrontmatter(await readFile(skill.source, "utf8"));
}
