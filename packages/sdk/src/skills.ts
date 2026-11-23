/**
 * `@theokit/sdk/skills` — first-party skill discovery + `<skills>` block.
 *
 * `discoverSkills(dir, options?)` discovers `<dir>/<name>/SKILL.md` files under
 * an ARBITRARY directory (not a hardcoded `.theokit/skills` root), parsing
 * strict YAML frontmatter (`name`/`description` required; `category`/
 * `dependencies` optional) and skipping malformed skills + symlink-escapes. It
 * never throws — a missing/unreadable/non-directory path yields `[]`.
 *
 * `buildSkillsBlock(skills)` renders the prompt-injection-safe `<skills>` system
 * prompt block (name + description XML-escaped; the skill body is not part of
 * the input type, so it cannot leak).
 *
 * `explainSkills(input)` reports which skills an agent would load, from which root, and which
 * were skipped, from the same walk the runtime performs.
 *
 * The first two are the same primitives the SDK runtime uses internally for
 * `.theokit/skills` discovery and `<skills>` injection — exposed so consumers
 * orient an agent with one import instead of hand-rolling discovery.
 */

export {
  type DiscoverSkillsOptions,
  discoverSkills,
  type InvalidSkillInfo,
  loadSkillInstructions,
  type Skill,
} from "./internal/runtime/skills/discover-skills.js";
export {
  type ExplainSkillsInput,
  explainSkills,
  type SkillsExplanation,
} from "./internal/runtime/skills/explain-skills.js";
export { buildSkillsBlock } from "./internal/runtime/skills/skills-block.js";
