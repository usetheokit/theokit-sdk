import type { CompatSource, SettingSource, SkillsSettings } from "../../../types/agent.js";
import { resolveCompatSources } from "../compat/compat-config-file.js";
import type { InvalidSkillInfo } from "./discover-skills.js";
import { resolveSkillRootsFor, type SkillRoot } from "./skill-roots.js";
import { SkillsManager } from "./skills-manager.js";

/** Input to {@link explainSkills}. */
export interface ExplainSkillsInput {
  cwd: string;
  skills?: SkillsSettings;
  /** Same meaning and default as `local.settingSources` in Agent.create. */
  settingSources?: SettingSource[];
  compatSources?: CompatSource[];
}

/** What {@link explainSkills} reports. */
export interface SkillsExplanation {
  /** Directories consulted, in precedence order. */
  roots: SkillRoot[];
  /** What the agent will see, after shadowing, inline override and `enabled`. */
  loaded: { name: string; source: string | "inline"; root: string | "inline" }[];
  invalid: InvalidSkillInfo[];
  shadowed: { name: string; winner: string; loser: string }[];
  /** Names in `skills.enabled` that no root or inline skill provides. */
  enabledButMissing: string[];
  /** Discovered skills that `skills.enabled` leaves out. */
  disabled: string[];
}

/**
 * Report which skills an agent created with these options loads, from which root, and which were
 * skipped. Runs the same `SkillsManager` walk the agent runs, so it cannot disagree with
 * `agent.skills.list()`.
 */
export async function explainSkills(input: ExplainSkillsInput): Promise<SkillsExplanation> {
  const manager = new SkillsManager(
    input.cwd,
    input.skills?.enabled,
    includesProject(input.settingSources),
    input.skills?.skillsDir,
    input.skills?.inline as never,
    compatFor(input),
    input.skills?.bundledDirs,
    input.skills?.userDir,
  );
  await manager.initialize();
  return manager.explain();
}

// Same rule as the agent: project settings are read only when asked for (or via "all").
function includesProject(sources: SettingSource[] | undefined): boolean {
  return sources !== undefined && (sources.includes("project") || sources.includes("all"));
}

function compatFor(input: ExplainSkillsInput) {
  return resolveCompatSources(
    { local: input.compatSources === undefined ? {} : { compatSources: input.compatSources } },
    input.cwd,
  );
}

/**
 * The ordered roots an agent created with these options reads (first declaration of a name wins).
 * Equals `explainSkills(input).roots`.
 */
export function resolveSkillRoots(input: ExplainSkillsInput): Promise<SkillRoot[]> {
  return resolveSkillRootsFor({
    cwd: input.cwd,
    includeProject: includesProject(input.settingSources),
    skillsDir: input.skills?.skillsDir,
    userDir: input.skills?.userDir,
    bundledDirs: input.skills?.bundledDirs,
    compatSources: compatFor(input),
  });
}
