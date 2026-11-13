/**
 * sdk-memory `migration` unit test (iter 63).
 *
 * Validates the iter 63 hybrid copy of `internal/memory/migration.ts`
 * from sdk-core. sdk-memory now ships the canonical legacy-JSON →
 * MEMORY.md one-shot migration per ADR D8.
 *
 * sdk-core retains its copy for v1.x active-memory back-compat.
 * Both copies byte-equivalent at runtime (same JSON shape parse,
 * same idempotency-key composition `cwd::namespace::scope::userId`,
 * same 4 typed `reason` values, same atomic markdown-append +
 * unlink semantics).
 *
 * Uses temp-dir + real file I/O (no mocks) per the no-stubs canon.
 * Migration flag map is reset between tests via
 * `resetMigrationStateForTests`.
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDiagnosticsSink } from "@theokit/sdk";
import {
  legacyMemoryJsonPath,
  type MemoryConfig,
  type MigrationResult,
  memoryMdPath,
  migrateLegacyJson,
  readFactsFromMarkdown,
  resetMigrationStateForTests,
  resolveMemoryRoot,
} from "@theokit/sdk-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function seedLegacyJson(
  cwd: string,
  config: MemoryConfig,
  facts: ReadonlyArray<{ text: string }>,
): Promise<string> {
  const jsonPath = legacyMemoryJsonPath(cwd, config);
  await mkdir(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ facts }), "utf8");
  return jsonPath;
}

describe("sdk-memory migration (iter 63)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sdk-memory-migration-"));
    resetMigrationStateForTests();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    resetMigrationStateForTests();
  });

  it("test_no_legacy_json_returns_typed_reason", async () => {
    const cfg: MemoryConfig = { enabled: true };
    const result: MigrationResult = await migrateLegacyJson(cwd, cfg);
    expect(result.migrated).toBe(false);
    expect(result.factCount).toBe(0);
    expect(result.reason).toBe("no-legacy-json");
  });

  it("test_migrates_facts_writes_markdown_unlinks_legacy_json", async () => {
    const cfg: MemoryConfig = { enabled: true };
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const diagnostics: string[] = [];
    setDiagnosticsSink((message) => diagnostics.push(message));

    try {
      const jsonPath = await seedLegacyJson(cwd, cfg, [{ text: "first" }, { text: "second" }]);
      const result = await migrateLegacyJson(cwd, cfg);

      expect(result.migrated).toBe(true);
      expect(result.factCount).toBe(2);

      // Both facts survive the migration and are readable afterwards. The assertion used to be
      // that `MEMORY.md` contained `- first` — the bullet layout that predates #389. What a
      // migration owes its caller is that nothing recorded was lost, not the shape it lands in,
      // and pinning the shape is what let this file keep passing while the store moved on (#430).
      const migrated = (await readFactsFromMarkdown(cwd)).map((f) => f.text);
      expect(migrated).toContain("first");
      expect(migrated).toContain("second");
      // The index the reader starts from has to name them, or the files are orphans.
      const index = await readFile(memoryMdPath(resolveMemoryRoot(cwd)), "utf8");
      expect(index).toContain("first.md");
      expect(index).toContain("second.md");

      // Legacy JSON was unlinked.
      await expect(access(jsonPath)).rejects.toThrow();

      // The breadcrumb. This asserted a line on `process.stderr`, which is where the copy this
      // package used to carry wrote it. The module is the SDK's now (#1068), and the SDK reports
      // through its diagnostics channel, silent unless the host installs a sink (#147). Same
      // message, asserted where it now goes, and stderr asserted quiet.
      expect(diagnostics.join("")).toContain("migrated 2 fact(s)");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      setDiagnosticsSink(undefined);
      stderrSpy.mockRestore();
    }
  });

  it("test_skips_when_MEMORY_md_already_present", async () => {
    const cfg: MemoryConfig = { enabled: true };
    await seedLegacyJson(cwd, cfg, [{ text: "ignored" }]);

    // Create MEMORY.md first.
    await mkdir(resolveMemoryRoot(cwd), { recursive: true });
    await writeFile(memoryMdPath(resolveMemoryRoot(cwd)), "# Memory\n\n## Facts\n\n- existing\n");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const diagnostics: string[] = [];
    setDiagnosticsSink((message) => diagnostics.push(message));
    try {
      const result = await migrateLegacyJson(cwd, cfg);
      expect(result.migrated).toBe(false);
      expect(result.reason).toBe("markdown-exists");

      // Existing MEMORY.md unchanged + legacy JSON NOT unlinked (both intact contract).
      const raw = await readFile(memoryMdPath(resolveMemoryRoot(cwd)), "utf8");
      expect(raw).toContain("- existing");
      expect(raw).not.toContain("- ignored");

      // On the diagnostics channel rather than stderr, for the reason given in the test above.
      expect(diagnostics.join("")).toContain("migration skipped");
      expect(diagnostics.join("")).toContain("leaving both intact");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      setDiagnosticsSink(undefined);
      stderrSpy.mockRestore();
    }
  });

  it("test_idempotent_same_key_returns_already_migrated_second_time", async () => {
    const cfg: MemoryConfig = { enabled: true };
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await seedLegacyJson(cwd, cfg, [{ text: "one" }]);

      const first = await migrateLegacyJson(cwd, cfg);
      expect(first.migrated).toBe(true);

      // Second call with the same key — flag map should short-circuit.
      const second = await migrateLegacyJson(cwd, cfg);
      expect(second.migrated).toBe(false);
      expect(second.reason).toBe("already-migrated");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("test_different_userId_keys_are_independent", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const alice: MemoryConfig = { enabled: true, userId: "alice" };
      const bob: MemoryConfig = { enabled: true, userId: "bob" };

      await seedLegacyJson(cwd, alice, [{ text: "alice-fact" }]);

      const r1 = await migrateLegacyJson(cwd, alice);
      expect(r1.migrated).toBe(true);

      // bob's key was never migrated — so it hits the no-legacy-json
      // branch (no file for bob); proves the keys are independent
      // (bob is NOT short-circuited by alice's migration).
      const r2 = await migrateLegacyJson(cwd, bob);
      expect(r2.migrated).toBe(false);
      expect(r2.reason).toBe("no-legacy-json");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("test_corrupted_json_returns_no_legacy_json_reason", async () => {
    const cfg: MemoryConfig = { enabled: true };
    const jsonPath = legacyMemoryJsonPath(cwd, cfg);
    await mkdir(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(jsonPath, "{ this is not valid json", "utf8");

    const result = await migrateLegacyJson(cwd, cfg);
    // readLegacyFacts swallows the JSON.parse error and returns undefined →
    // the caller maps that to "no-legacy-json".
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe("no-legacy-json");
  });
});
