/**
 * Shared `baseDir` resolver for the file-writing tools (#1060): the base for RELATIVE paths in the
 * model's input, kept separate from `projectRoot`, which stays the confinement boundary.
 *
 * @internal
 */

import { isAbsolute, relative, resolve } from "node:path";

/** `baseDir` is not `projectRoot` or a directory inside it. */
export class BaseDirOutsideProjectRootError extends Error {
  readonly baseDir: string;
  readonly projectRoot: string;
  constructor(tool: string, baseDir: string, projectRoot: string) {
    super(
      `${tool}: baseDir "${baseDir}" must be projectRoot or a directory inside projectRoot "${projectRoot}"`,
    );
    this.name = "BaseDirOutsideProjectRootError";
    this.baseDir = baseDir;
    this.projectRoot = projectRoot;
  }
}

/** Resolve the effective base at construction (default `projectRoot`); throws when outside the root. */
export function resolveBaseDir(tool: string, projectRoot: string, baseDir?: string): string {
  if (baseDir === undefined) return projectRoot;
  const base = resolve(projectRoot, baseDir);
  const rel = relative(resolve(projectRoot), base);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new BaseDirOutsideProjectRootError(tool, baseDir, projectRoot);
  }
  return base;
}

/** Anchor a model-supplied path: absolute is unchanged, relative resolves against `base`. */
export function anchorPath(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
