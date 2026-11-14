import type { CompatSource, SettingSource, SkillsSettings } from "../../../types/agent.js";
import { resolveCompatSources } from "../compat/compat-config-file.js";
import type { InvalidSkillInfo } from "./discover-skills.js";
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
  roots: { dir: string; kind: "skillsDir" | "project" | "plugin" | "bundled" }[];
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
  const sources = input.settingSources;
  // Same rule as the agent: project settings are read only when asked for (or via "all").
  const includeProject =
    sources !== undefined && (sources.includes("project") || sources.includes("all"));
  const manager = new SkillsManager(
    input.cwd,
    input.skills?.enabled,
    includeProject,
    input.skills?.skillsDir,
    input.skills?.inline as never,
    resolveCompatSources(
      { local: input.compatSources === undefined ? {} : { compatSources: input.compatSources } },
      input.cwd,
    ),
    input.skills?.bundledDirs,
  );
  await manager.initialize();
  return manager.explain();
}
