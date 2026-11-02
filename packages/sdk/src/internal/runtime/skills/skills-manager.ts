import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SystemPromptSkillRef } from "../../../types/sdk-agent.js";
import { diag } from "../../diagnostics.js";
import { projectConfigRoots } from "../../persistence/paths.js";
import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";
import { pluginBundleDirs } from "../plugin-loader/plugin-bundles.js";
import { discoverSkills, type Skill } from "./discover-skills.js";
import { stripSkillFrontmatter } from "./skill-frontmatter.js";

/**
 * Skill metadata exposed via `agent.skills.list()`. Full skill prompt bodies
 * are NEVER returned — only frontmatter fields.
 *
 * @internal
 */
export type SkillMetadata = Skill;

/**
 * A stored skill row. Filesystem skills are a bare {@link Skill}; inline
 * (`createSkill`) skills additionally carry their `instructions` body + optional
 * `references` on the object. Typing the store this way lets `get()` read those
 * fields directly, without a cast. @internal
 */
type StoredSkill = Skill & { instructions?: string; references?: Record<string, string> };

/** SE20 — a skill resolved with its body (+ SE21 references). @internal */
export interface SkillDetail {
  name: string;
  description: string;
  instructions: string;
  references?: Record<string, string>;
}

/** SE20 — the internal `agent.skills` handle shape (list + get), shared by the runtime wiring. @internal */
export interface SkillsHandle {
  /**
   * Lean listing — metadata only, never a body. Inline skills carry their body + references on the
   * underlying object; the public handle projects them away so `agent.skills.list()` never leaks
   * one. Full bodies come only via `get`.
   *
   * Typed as the PUBLIC {@link SystemPromptSkillRef} rather than restating its shape inline: the
   * two had drifted, and a handle declaring a narrower shape than the contract it serves silently
   * deletes fields the projection produces — which is how `source` reached the caller at runtime
   * and did not exist to the compiler (#524).
   */
  list: () => Promise<SystemPromptSkillRef[]>;
  get: (name: string) => Promise<SkillDetail | undefined>;
}

/**
 * File-based skills loader. Discovers `.theokit/skills/<name>/SKILL.md`
 * frontmatter when `local.settingSources` includes `"project"`.
 *
 * Delegates the discovery loop to the shared `discoverSkills` primitive (M4-1,
 * single source of truth, also public via `@theokit/sdk/skills`). Per the
 * strict-frontmatter ADR + EC-5, a malformed skill is excluded from `list()`
 * and emits a stderr warning; the agent run continues without it.
 *
 * @internal
 */
export class SkillsManager {
  private skills: StoredSkill[] = [];

  constructor(
    private readonly cwd: string,
    _enabled: string[] | undefined,
    private readonly settingSourcesIncludeProject: boolean,
    // M22 — optional custom skills directory + inline (code-defined) skills.
    private readonly skillsDir?: string,
    private readonly inline?: StoredSkill[],
    /**
     * Declared foreign dialects (#524). Empty reads `.theokit/` only.
     *
     * The quietest of the four subsystems and the one worth stating: a skill's text enters the
     * SYSTEM PROMPT, so importing skills from a directory this SDK does not own is a
     * prompt-injection surface, not a convenience.
     */
    private readonly compatSources: readonly CompatSourceDeclaration[] = [],
    /**
     * B-546 — roots an application bundles in its own package. Ranked below every other root: the
     * first declaration of a name wins, so a workspace skill shadows a bundled one.
     */
    private readonly bundledDirs: readonly string[] = [],
  ) {
    void _enabled;
  }

  async initialize(): Promise<void> {
    // M22 — inline skills work even without project setting sources (they need no filesystem).
    if (!this.settingSourcesIncludeProject) {
      this.skills = this.mergeInline([]);
      return;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    // M22 — a custom skillsDir overrides the roots entirely: an explicit directory means THAT
    // directory, so it must not quietly gain a second source.
    //
    // Otherwise every project config root is read (`.theokit/skills`, then `.claude/skills`), and
    // the FIRST declaration of a name wins. Skills authored for the Claude Code CLI need no
    // conversion — measured 2026-08-26, `SkillFrontmatter` requires exactly the `name` and
    // `description` the CLI writes; only the directory was never looked at.
    // A Claude Code plugin is a bundle whose `skills/` is what it contributes; bundles come after
    // the project's own roots so a project can shadow a skill a plugin ships without editing it.
    const ownRoots =
      this.skillsDir === undefined
        ? [
            ...projectConfigRoots(this.cwd, this.compatSources, "skills").map((root) =>
              join(root, "skills"),
            ),
            ...(await pluginBundleDirs(this.cwd, this.compatSources)).map((b) => join(b, "skills")),
          ]
        : [this.skillsDir];
    const roots = [...ownRoots, ...this.bundledDirs];
    const discovered: StoredSkill[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      for (const skill of await discoverSkills(root, {
        onInvalidSkill: (info) => {
          diag(`[theokit-sdk] skill ${info.name} skipped (${info.code}): ${info.message}\n`);
        },
      })) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        discovered.push(skill);
      }
    }
    this.skills = this.mergeInline(discovered);
  }

  /** M22 — merge inline skills over discovered ones; inline wins on a name conflict. */
  private mergeInline(discovered: StoredSkill[]): StoredSkill[] {
    if (this.inline === undefined || this.inline.length === 0) return discovered;
    const inlineNames = new Set(this.inline.map((s) => s.name));
    return [...discovered.filter((s) => !inlineNames.has(s.name)), ...this.inline];
  }

  list(): Promise<SkillMetadata[]> {
    // Return every discovered skill — `enabled` is a runtime hint for which
    // skills the parent agent may invoke, not a visibility filter.
    return Promise.resolve(this.skills);
  }

  /**
   * SE20 — resolve a skill by name INCLUDING its body. Inline (`createSkill`)
   * skills carry `instructions` on the object; filesystem skills read the body
   * from their `source` SKILL.md (frontmatter stripped). `undefined` when no
   * enabled skill matches (malformed skills were already excluded at discovery).
   */
  async get(name: string): Promise<SkillDetail | undefined> {
    const skill = this.skills.find((s) => s.name === name);
    if (skill === undefined) return undefined;
    // Inline skills carry the body; filesystem skills re-read it from `source`.
    const instructions =
      typeof skill.instructions === "string"
        ? skill.instructions
        : stripSkillFrontmatter(await readFile(skill.source, "utf8"));
    // SE21 — inline skills may bundle `references`; filesystem skills carry none here.
    const references = skill.references;
    return {
      name: skill.name,
      description: skill.description,
      instructions,
      ...(references !== undefined ? { references } : {}),
    };
  }
}
