import { access, readFile, unlink } from "node:fs/promises";
import { diag } from "../diagnostics.js";
import { appendFactToMarkdown, memoryMdPath } from "./storage/markdown-store.js";
import { resolveMemoryRoot } from "./storage/memory-root.js";
import { legacyMemoryJsonPath, type MemoryConfig, type MemoryFact } from "./types.js";

/**
 * One-shot legacy-JSON → markdown migration (ADR D8 of memory-system-peer-project-parity).
 *
 * Triggers when `.theokit/memory/<namespace>/<scope>-<userId>.json` exists AND
 * `.theokit/memory/MEMORY.md` does not. Reads the JSON facts, writes each
 * bullet to MEMORY.md, then deletes the JSON file. Idempotent.
 *
 * @internal
 */

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readLegacyFacts(jsonPath: string): Promise<MemoryFact[] | undefined> {
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { facts?: MemoryFact[] };
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch {
    return undefined;
  }
}

async function writeMigratedFacts(
  cwd: string,
  jsonPath: string,
  facts: MemoryFact[],
  targetDir: string,
): Promise<MigrationResult> {
  try {
    for (const fact of facts) await appendFactToMarkdown(cwd, fact, targetDir);
    await unlink(jsonPath).catch(() => undefined);
    diag(`[theokit-sdk] migrated ${facts.length} fact(s) from ${jsonPath} to MEMORY.md\n`);
    return { migrated: true, factCount: facts.length };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    diag(`[theokit-sdk] memory migration failed (readonly fs?): ${message}\n`);
    return { migrated: false, factCount: 0, reason: "readonly-fs" };
  }
}

const migrationRun = new Set<string>();

/**
 * Outcome of {@link migrateLegacyJson}. `reason` is present on every non-migrated
 * result and says which guard stopped it: `already-migrated` (this key was
 * attempted earlier in this process), `no-legacy-json` (nothing to migrate, or
 * the file could not be read or parsed), `markdown-exists` (both files present,
 * so neither was touched), `readonly-fs` (the write failed).
 */
export interface MigrationResult {
  migrated: boolean;
  factCount: number;
  reason?: "already-migrated" | "no-legacy-json" | "markdown-exists" | "readonly-fs";
}

/**
 * Move facts from the pre-markdown JSON store into `MEMORY.md`, once.
 *
 * It runs only when the legacy file exists and `MEMORY.md` does not. When both
 * exist it stops and leaves both alone: merging would need a conflict rule
 * nobody has picked, and losing hand-written notes is worse than skipping. On
 * success each fact is appended under the memory root (`config.directory`, or
 * `<cwd>/.theokit/memory` without one) and the JSON file is deleted.
 *
 * Guarded by a per-process set keyed on cwd, namespace, scope and user id, so
 * the second call for the same key returns `already-migrated` without touching
 * disk, including after a genuine failure. `@theokit/sdk-memory` re-exports
 * this function rather than copying it, so that set is one per process however
 * the function was imported (#1068).
 *
 * Never throws: a JSON file that cannot be read or parsed reports
 * `no-legacy-json`, and a failed write reports `readonly-fs` after a message
 * on the diagnostics sink.
 */
export async function migrateLegacyJson(
  cwd: string,
  config: MemoryConfig,
): Promise<MigrationResult> {
  const key = `${cwd}::${config.namespace ?? "default"}::${config.scope ?? "agent"}::${config.userId ?? "default"}`;
  if (migrationRun.has(key)) return { migrated: false, factCount: 0, reason: "already-migrated" };
  migrationRun.add(key);

  const jsonPath = legacyMemoryJsonPath(cwd, config);
  if (!(await fileExists(jsonPath))) {
    return { migrated: false, factCount: 0, reason: "no-legacy-json" };
  }
  const root = resolveMemoryRoot(cwd, config);
  if (await fileExists(memoryMdPath(root))) {
    diag(
      `[theokit-sdk] memory migration skipped: both MEMORY.md and legacy JSON exist at ${jsonPath}; leaving both intact\n`,
    );
    return { migrated: false, factCount: 0, reason: "markdown-exists" };
  }

  const facts = await readLegacyFacts(jsonPath);
  if (facts === undefined) return { migrated: false, factCount: 0, reason: "no-legacy-json" };
  return writeMigratedFacts(cwd, jsonPath, facts, root);
}

/** Test-only — reset the in-process migration flag map. */
export function resetMigrationStateForTests(): void {
  migrationRun.clear();
}
