import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { SandboxMode } from "./bwrap.js";

/** Paths the confined shell must keep: masking one would remove the command's own working ground. */
const KEPT_ROOTS_ALWAYS = ["/tmp"] as const;

/** True when `inner` is `outer` or lies under it. */
function isSameOrInside(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveEntry(entry: string): string {
  if (!path.isAbsolute(entry)) {
    throw new TypeError(`denyReadPaths: "${entry}" is not an absolute path`);
  }
  try {
    return realpathSync(entry);
  } catch (cause) {
    throw new TypeError(`denyReadPaths: "${entry}" cannot be resolved: ${String(cause)}`);
  }
}

function keptRoots(cwd: string): string[] {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // cwd does not exist yet: the resolved spelling is the only one there is
  }
  return [...new Set([cwd, real, ...KEPT_ROOTS_ALWAYS])];
}

/**
 * The bwrap flags that make each path in `paths` unreadable inside the sandbox: `--tmpfs` for a
 * directory, `--ro-bind /dev/null` for a file. Callers place them after the writable binds so the
 * mask wins over a path inside the workspace or `/tmp`.
 *
 * Every entry is resolved through symlinks first, so reading through a link is denied too, and
 * duplicates collapse in list order. A masked file is still listed in its directory; only reading it
 * fails.
 *
 * Throws `TypeError` (never skips) for a relative or missing entry, an entry that equals or contains
 * the working directory, `/tmp` or `/`, and any non-empty list under `danger-full-access`, where no
 * mask can be applied.
 */
export function denyReadFlags(
  paths: readonly string[] | undefined,
  policy: { mode: SandboxMode; cwd: string },
): string[] {
  if (paths === undefined || paths.length === 0) return [];
  if (policy.mode === "danger-full-access") {
    throw new TypeError(
      "denyReadPaths cannot be honoured under danger-full-access: no sandbox is applied",
    );
  }
  const roots = keptRoots(policy.cwd);
  const resolved = new Set<string>();
  for (const entry of paths) {
    const target = resolveEntry(entry);
    const covered = roots.find((root) => isSameOrInside(target, root));
    if (covered !== undefined) {
      throw new TypeError(
        `denyReadPaths: "${entry}" would hide "${covered}", which the command needs`,
      );
    }
    resolved.add(target);
  }
  return [...resolved].flatMap((target) =>
    statSync(target).isDirectory() ? ["--tmpfs", target] : ["--ro-bind", "/dev/null", target],
  );
}
