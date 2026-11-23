import { readFile } from "node:fs/promises";
import type { SystemPromptSkillRef } from "../../../types/sdk-agent.js";
import { diag } from "../../diagnostics.js";
import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";
import { discoverSkills, type InvalidSkillInfo, type Skill } from "./discover-skills.js";
import { stripSkillFrontmatter } from "./skill-frontmatter.js";
import { resolveSkillRootsFor, type SkillRoot } from "./skill-roots.js";

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

type TaggedRoot = SkillRoot;

/** What one walk saw: the report `explainSkills` returns, recorded by `discoverFrom`. @internal */
export interface SkillsExplanationReport {
  roots: TaggedRoot[];
  loaded: { name: string; source: string; root: string }[];
  invalid: InvalidSkillInfo[];
  shadowed: { name: string; winner: string; loser: string }[];
  enabledButMissing: string[];
  disabled: string[];
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
  private walk: {
    roots: TaggedRoot[];
    rootOf: Map<string, string>;
    sourceOf: Map<string, string>;
    invalid: InvalidSkillInfo[];
    shadowed: { name: string; winner: string; loser: string }[];
  } = { roots: [], rootOf: new Map(), sourceOf: new Map(), invalid: [], shadowed: [] };

  constructor(
    private readonly cwd: string,
    private readonly enabled: string[] | undefined,
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
    /** An application-provided user-level root, read after project and plugin roots, before bundled. */
    private readonly userDir?: string,
  ) {}

  async initialize(): Promise<void> {
    // M22 — inline skills work even without project setting sources (they need no filesystem).
    // B-546 — user and bundled roots are the application's own, not project settings, so they are
    // read even when project sources are off.
    await this.refresh();
  }

  async refresh(): Promise<void> {
    // Order and rules live in `resolveSkillRootsFor`, shared with the public root list.
    const roots = await resolveSkillRootsFor({
      cwd: this.cwd,
      includeProject: this.settingSourcesIncludeProject,
      skillsDir: this.skillsDir,
      userDir: this.userDir,
      bundledDirs: this.bundledDirs,
      compatSources: this.compatSources,
    });
    this.skills = this.mergeInline(await this.discoverFrom(roots));
  }

  private async discoverFrom(roots: readonly TaggedRoot[]): Promise<StoredSkill[]> {
    const discovered: StoredSkill[] = [];
    const winners = new Map<string, string>();
    const walk: typeof this.walk = {
      roots: [...roots],
      rootOf: new Map(),
      sourceOf: new Map(),
      invalid: [],
      shadowed: [],
    };
    for (const root of roots) {
      for (const skill of await discoverSkills(root.dir, {
        onInvalidSkill: (info) => {
          walk.invalid.push(info);
          diag(`[theokit-sdk] skill ${info.name} skipped (${info.code}): ${info.message}\n`);
        },
      })) {
        const winner = winners.get(skill.name);
        if (winner !== undefined) {
          walk.shadowed.push({ name: skill.name, winner, loser: skill.source });
          continue;
        }
        winners.set(skill.name, skill.source);
        walk.rootOf.set(skill.name, root.dir);
        walk.sourceOf.set(skill.name, skill.source);
        discovered.push(skill);
      }
    }
    this.walk = walk;
    return discovered;
  }

  /**
   * The report behind `explainSkills`: recorded by the same walk that filled `list()`, so the two
   * cannot disagree. Call after `initialize()`.
   */
  explain(): SkillsExplanationReport {
    const inlineNames = new Set((this.inline ?? []).map((s) => s.name));
    const shadowed = this.walk.shadowed.map((e) =>
      inlineNames.has(e.name) ? { ...e, winner: "inline" } : e,
    );
    for (const [name, loser] of this.walk.sourceOf) {
      if (inlineNames.has(name)) shadowed.push({ name, winner: "inline", loser });
    }
    const allowed = this.enabled;
    const present = new Set(this.skills.map((s) => s.name));
    const loaded = this.visible().map((s) => {
      const isInline = inlineNames.has(s.name);
      return {
        name: s.name,
        source: isInline ? "inline" : s.source,
        root: isInline ? "inline" : (this.walk.rootOf.get(s.name) ?? ""),
      };
    });
    return {
      roots: this.walk.roots,
      loaded,
      invalid: this.walk.invalid,
      shadowed,
      enabledButMissing: allowed === undefined ? [] : allowed.filter((n) => !present.has(n)),
      disabled:
        allowed === undefined
          ? []
          : [...this.walk.sourceOf.keys()].filter((n) => !allowed.includes(n)),
    };
  }

  /** M22 — merge inline skills over discovered ones; inline wins on a name conflict. */
  private mergeInline(discovered: StoredSkill[]): StoredSkill[] {
    if (this.inline === undefined || this.inline.length === 0) return discovered;
    const inlineNames = new Set(this.inline.map((s) => s.name));
    return [...discovered.filter((s) => !inlineNames.has(s.name)), ...this.inline];
  }

  private visible(): StoredSkill[] {
    const allowed = this.enabled;
    return allowed === undefined
      ? this.skills
      : this.skills.filter((s) => allowed.includes(s.name));
  }

  list(): Promise<SkillMetadata[]> {
    // B-547 — `enabled`, when set, restricts which skills exist for the agent at all.
    return Promise.resolve(this.visible());
  }

  /**
   * SE20 — resolve a skill by name INCLUDING its body. Inline (`createSkill`)
   * skills carry `instructions` on the object; filesystem skills read the body
   * from their `source` SKILL.md (frontmatter stripped). `undefined` when no
   * enabled skill matches (malformed skills were already excluded at discovery).
   */
  async get(name: string): Promise<SkillDetail | undefined> {
    const skill = this.visible().find((s) => s.name === name);
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
