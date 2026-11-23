import { join } from "node:path";
import { projectConfigRoots } from "../../persistence/paths.js";
import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";
import { pluginBundleDirs } from "../plugin-loader/plugin-bundles.js";

/** The kind of a consulted skill root, in the order `explainSkills` reports them. */
export type SkillRootKind = "skillsDir" | "project" | "plugin" | "user" | "bundled";

/** One consulted skill root. */
export interface SkillRoot {
  dir: string;
  kind: SkillRootKind;
}

/** What decides which roots are read. */
export interface SkillRootsInput {
  cwd: string;
  /** Whether project setting sources are on. */
  includeProject: boolean;
  skillsDir?: string;
  userDir?: string;
  bundledDirs?: readonly string[];
  compatSources?: readonly CompatSourceDeclaration[];
}

/**
 * The ordered skill roots an agent reads; the first declaration of a name wins. Order: `skillsDir`
 * (replacing project and plugin roots) or project roots then plugin bundles, then `userDir`, then
 * bundled roots. `userDir` and bundled roots are application-provided, so they are read even when
 * project sources are off; `skillsDir`, project and plugin roots are not.
 */
export async function resolveSkillRootsFor(input: SkillRootsInput): Promise<SkillRoot[]> {
  const roots = input.includeProject ? await projectSideRoots(input) : [];
  if (input.userDir !== undefined) roots.push({ dir: input.userDir, kind: "user" });
  for (const dir of input.bundledDirs ?? []) roots.push({ dir, kind: "bundled" });
  return roots;
}

async function projectSideRoots(input: SkillRootsInput): Promise<SkillRoot[]> {
  if (input.skillsDir !== undefined) return [{ dir: input.skillsDir, kind: "skillsDir" }];
  const compat = input.compatSources ?? [];
  return [
    ...projectConfigRoots(input.cwd, compat, "skills").map(
      (root): SkillRoot => ({ dir: join(root, "skills"), kind: "project" }),
    ),
    ...(await pluginBundleDirs(input.cwd, compat)).map(
      (b): SkillRoot => ({ dir: join(b, "skills"), kind: "plugin" }),
    ),
  ];
}
