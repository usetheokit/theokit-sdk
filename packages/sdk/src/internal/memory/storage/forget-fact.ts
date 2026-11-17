import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { replaceFileAtomic } from "../../persistence/atomic-write.js";
import { withCwdMutex } from "../../persistence/cwd-mutex.js";
import { safeFilenameForId } from "../../security/path-guard.js";
import type { MemoryConfig } from "../types.js";
import { resolveMemoryRoot } from "./memory-root.js";

/** The part of `LanceIndex` a forget needs; structural so this module never imports Lance. */
export interface FactIndexForget {
  removeFacts: (
    ids: ReadonlyArray<string>,
    scope?: { namespace: string; source: "memory" | "sessions" | "wiki" },
  ) => Promise<void>;
}

/**
 * Forget one memory: delete `<name>.md`, drop its `MEMORY.md` line, then remove its rows from the
 * Lance index, scoped to `namespace` and source `memory` so notes and other sources are untouched.
 * The index call is queued behind any `addFacts` in flight on the same storage, so a running sync
 * cannot bring the fact back once this resolves. Resolves `false` when no such memory exists.
 */
export async function forgetFact(
  cwd: string,
  config: MemoryConfig,
  name: string,
  index?: { lance: FactIndexForget; namespace: string },
): Promise<boolean> {
  if (!config.enabled) return false;
  const dir = resolveMemoryRoot(cwd, config);
  const file = `${name}.md`;
  if (name.length === 0 || name !== safeFilenameForId(name)) return false;
  const removed = await withCwdMutex(dir, async () => {
    try {
      await unlink(join(dir, file));
    } catch {
      return false;
    }
    try {
      const existing = await readFile(join(dir, "MEMORY.md"), "utf8");
      const kept = existing
        .split("\n")
        .filter((line) => !line.startsWith("- [") || !line.includes(`](${file})`));
      await replaceFileAtomic(join(dir, "MEMORY.md"), kept.join("\n"));
    } catch {
      // no index to update
    }
    return true;
  });
  if (removed && index !== undefined) {
    await index.lance.removeFacts([name], { namespace: index.namespace, source: "memory" });
  }
  return removed;
}
