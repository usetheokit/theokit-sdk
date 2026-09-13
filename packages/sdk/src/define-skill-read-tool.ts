/**
 * SE23 — `defineSkillReadTool`: an OPT-IN factory that gives the MODEL on-demand
 * access to a skill's full body + references via a `skill_read` tool.
 *
 * TheoKit discloses skills eagerly through the `<skills>` system-prompt block
 * (name + description only). This factory is the LAZY read path: the consumer
 * explicitly adds the returned {@link CustomTool} to `tools`, and when the model
 * calls it with a skill name, it gets that skill's `instructions` (+ SE21
 * `references`). The SDK NEVER auto-injects it — bring-your-own-tools stays
 * intact (sibling of `defineSubAgent` / `workflowAsTool`). See ADR 0007.
 *
 *   import { Agent, createSkill, defineSkillReadTool } from "@theokit/sdk";
 *
 *   const skills = [createSkill({ name: "release", description: "…", instructions: "…" })];
 *   const agent = await Agent.create({
 *     model: { id: "openai/gpt-4o-mini" },
 *     skills: { inline: skills },
 *     tools: [defineSkillReadTool(skills)],
 *   });
 *
 * @public
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";
import type { InlineSkill } from "./create-skill.js";
import { ConfigurationError } from "./errors.js";
import type { Skill as DiscoveredSkill } from "./internal/runtime/skills/discover-skills.js";
import { stripSkillFrontmatter } from "./internal/runtime/skills/skill-frontmatter.js";
import { toJsonSchema } from "./internal/zod-to-json-schema.js";
import type { CustomTool } from "./types/agent.js";

/**
 * What `skill_read` can read: a skill that carries its body, or one that knows where its body is.
 *
 * The tool used to take `InlineSkill` alone. A skill discovered on disk is a `Skill`, whose own
 * declaration says "the skill BODY is never included" — so it did not fit through the door at all,
 * and the entire on-disk surface was advertised to the model and unreadable by it: a `SKILL.md`
 * listed by name and description, with the instructions under the frontmatter unable to arrive.
 */
export type ReadableSkill = InlineSkill | DiscoveredSkill;

/**
 * Produce the body and references for either shape.
 *
 * Read when the model ASKS, not at construction. Eager reading would turn "this agent knows about
 * twelve skills" into twelve file reads at startup, to answer a question the model usually does not
 * ask — and the handler's contract already allows a promise, so laziness costs one `await` and no
 * new API.
 *
 * A disk skill's `references/` directory is read here for the same reason inline skills already
 * render theirs in full: the two shapes describe the same thing, and one of them arriving empty is
 * the asymmetry this closes. An unreadable or absent `references/` yields none — a skill with no
 * supporting documents is the ordinary case, not an error.
 */
async function resolveBody(
  skill: ReadableSkill,
): Promise<{ instructions: string; references?: Record<string, string> }> {
  if (typeof (skill as InlineSkill).instructions === "string") {
    const inline = skill as InlineSkill;
    return inline.references === undefined
      ? { instructions: inline.instructions }
      : { instructions: inline.instructions, references: inline.references };
  }
  const source = (skill as DiscoveredSkill).source;
  const skillDir = dirname(source);
  const body = stripSkillFrontmatter(await readFile(source, "utf8"));
  const instructions = body.replaceAll(SKILL_DIR_PLACEHOLDER, skillDir);
  const references = await readReferences(skillDir);
  return references === undefined ? { instructions } : { instructions, references };
}

/**
 * `${CLAUDE_SKILL_DIR}` — the skill's own directory, and the reason skills are directories.
 *
 * A skill ships scripts and reference documents beside its `SKILL.md`, and the body has to point at
 * them. Without this there is no expressible path: the skill does not know where it was installed,
 * and neither does its author at the time of writing.
 *
 * Substituted ONLY for a skill read from disk. An inline skill has no directory — nothing was
 * installed anywhere — so the text is left exactly as written. That is an honest limit rather than a
 * guess: leaving it says "this does not apply here", while inventing a path would hand the model a
 * command that fails somewhere plausible.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal text a skill body contains, not an unescaped template literal
const SKILL_DIR_PLACEHOLDER = "${CLAUDE_SKILL_DIR}";

/** Read `<skillDir>/references/*` into the same `filename → content` map inline skills carry. */
async function readReferences(skillDir: string): Promise<Record<string, string> | undefined> {
  const dir = join(skillDir, "references");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const refs: Record<string, string> = {};
  for (const name of names) {
    try {
      refs[name] = await readFile(join(dir, name), "utf8");
    } catch {
      // A subdirectory, a dangling symlink, a file that vanished between the listing and the read.
      // Skipping one document is right; failing the whole read would make a skill unreadable
      // because something beside it was.
    }
  }
  return Object.keys(refs).length > 0 ? refs : undefined;
}

const SkillReadInputSchema = z.object({
  name: z.string().min(1, "skill_read: `name` is required."),
});

/**
 * Render a skill's body (+ references) into a single model-facing string.
 * `skill.name` is expected to be a short identifier-like token (no newlines /
 * Markdown headings) — the consumer controls both the names and the tool, so
 * this is a formatting assumption, not a trust boundary.
 */
async function renderSkill(skill: ReadableSkill): Promise<string> {
  const { instructions, references } = await resolveBody(skill);
  const parts = [`# Skill: ${skill.name}`, "", instructions];
  const refs = references;
  if (refs !== undefined && Object.keys(refs).length > 0) {
    parts.push("", "## References");
    for (const [file, content] of Object.entries(refs)) {
      parts.push("", `### ${file}`, content);
    }
  }
  return parts.join("\n");
}

/**
 * SE23 — build an OPT-IN `skill_read` {@link CustomTool} over the given inline
 * skills. When the model calls it with `{ name }`, the handler returns that
 * skill's body + references. An UNKNOWN (but well-formed) name returns a typed
 * "not found" string the model can act on — NOT a throw that kills the run.
 * Malformed input (missing `name`) fails at the trust boundary via the schema.
 *
 * The consumer controls exposure by choosing which skills to pass; the SDK
 * never auto-injects this tool.
 *
 * @public
 */
function defineSkillReadTool(skills: ReadonlyArray<ReadableSkill>): CustomTool {
  // Fail fast on duplicate names (Rule 8): a shadowed skill would be silently
  // unreachable and the "not found" list would show the name twice. Names are
  // addressed by exact, case-sensitive match — the same identity the <skills>
  // block uses — so a collision is a construction-time error, not a runtime one.
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new ConfigurationError(`defineSkillReadTool: duplicate skill name "${skill.name}".`, {
        code: "duplicate_skill_name",
      });
    }
    seen.add(skill.name);
  }
  return {
    name: "skill_read",
    description:
      "Read a skill's full instructions (and any bundled reference documents) by its name. " +
      "Use this to load the body of a skill listed in the <skills> block before acting on it.",
    inputSchema: toJsonSchema(SkillReadInputSchema),
    // NOT `async`. Marking the whole handler async turns the schema's SYNCHRONOUS throw into a
    // rejected promise, and this module's contract is that malformed input "fails at the trust
    // boundary via the schema" — measured, two trust-boundary tests went from throwing to
    // returning `undefined`. Only the body read needs to be asynchronous, so only it returns a
    // promise: parse and the not-found answer stay exactly as synchronous as they were.
    handler: (input: Record<string, unknown>): string | Promise<string> => {
      const { name } = SkillReadInputSchema.parse(input);
      const skill = skills.find((s) => s.name === name);
      if (skill === undefined) {
        const available = skills.map((s) => s.name).join(", ");
        return `Skill "${name}" not found. Available skills: ${available.length > 0 ? available : "(none)"}.`;
      }
      return renderSkill(skill);
    },
  };
}

/** SE36 — `SkillReadTool.create` replaces `defineSkillReadTool` (ADR 0015). @public  *
 * `SkillReadTool.create` returns a **`CustomTool`** — a skill-reading tool, not a
 * `SkillReadTool` instance.
 */
export class SkillReadTool {
  private constructor() {}
  static create(skills: ReadonlyArray<ReadableSkill>): CustomTool {
    return defineSkillReadTool(skills);
  }
}
