import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const SRC_ROOT = join(__dirname, "..", "..", "src");

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    if ((await stat(full)).isDirectory()) await walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const STATIC_IMPORT = /from\s+"([^"]+\.js)"/g;
/** `await import("./x.js")` — missing these makes the check report a false orphan. */
const DYNAMIC_IMPORT = /import\(\s*"([^"]+\.js)"\s*\)/g;

/** Absolute `.ts` paths that `file` imports, static and dynamic alike. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers = [
    ...[...text.matchAll(STATIC_IMPORT)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(DYNAMIC_IMPORT)].map((m) => m[1] ?? ""),
  ];
  return specifiers
    .filter((s) => s.startsWith("."))
    .map((s) => `${resolve(join(file, "..", s)).slice(0, -3)}.ts`);
}

/** Absolute `.ts` paths that some file under `src/` imports. */
function importedFrom(files: readonly string[]): Set<string> {
  return new Set(files.flatMap(importsOf));
}

/**
 * Modules under `src/internal/` whose only importer is a test.
 *
 * `knip.json` cannot see these, and not by accident: it declares `tests/**` as ENTRY POINTS, so a
 * module reachable from a test is reachable by definition and `quality:dead` will never report it.
 * Widening knip's entries is not the fix — dropping `tests/**` reports every test helper as unused
 * and the gate gets turned off, which `report-dead-code-scope.mjs` already documents. D3 does not
 * cover it either: it audits the DECLARED surface (what `package.json` exports points at), and none
 * of these is exported.
 *
 * So the project's own `rules/code-quality-golden-rule.md` § 5 states the principle — "A test is not
 * a consumer, for the same reason pillar (a) of the wiring triad does not count one" — while the
 * configured tool says the opposite, and the configured tool is the one that runs. This is the
 * narrow check that answers only this question.
 *
 * THE ALLOWLIST IS DEBT, NOT AN EXEMPTION. These 15 were measured on 2026-09-02 and are recorded so a
 * SIXTEENTH cannot arrive in silence. Each is speculative generality a test kept green; emptying the
 * list is per-module work, because "nothing imports it" and "this should be deleted" are different
 * claims and only reading settles which applies.
 */
const KNOWN_TEST_ONLY = new Set([
  "internal/judge/types.ts",
  "internal/judge/verify-side-effect.ts",
  "internal/llm/credential-pool-store.ts",
  "internal/persistence/pagination.ts",
  "internal/personality/resolver.ts",
  "internal/runtime/compression/compression-attempt.ts",
  "internal/runtime/lifecycle/auto-summarize.ts",
  "internal/runtime/tools/hitl-middleware.ts",
  "internal/security/test-reset.ts",
  "internal/tool-dispatch/dispatch.ts",
  "internal/tool-registry/check-fn-cache.ts",
  "internal/tool-registry/result-cap.ts",
  "internal/tool-registry/toolset.ts",
  "internal/workflow/evented-executor.ts",
]);

describe("no new internal module whose only consumer is a test", () => {
  let orphans: string[] = [];
  let scanned: string[] = [];

  beforeAll(async () => {
    scanned = await walk(SRC_ROOT);
    const imported = importedFrom(scanned);
    orphans = scanned
      .filter((f) => f.includes(`${join("src", "internal")}`) && !f.endsWith("index.ts"))
      .filter((f) => !imported.has(resolve(f)))
      .map((f) => relative(SRC_ROOT, f).split("\\").join("/"));
  });

  it("walks the tree and resolves imports — a broken walk would report every module an orphan", () => {
    expect(scanned.length, "the source walk found almost nothing").toBeGreaterThan(400);
    expect(
      orphans.length,
      "more than half of internal/ reported as orphaned means the import resolution broke, " +
        "not that the tree changed",
    ).toBeLessThan(60);
  });

  it("finds no orphan outside the recorded set", () => {
    expect(
      orphans.filter((o) => !KNOWN_TEST_ONLY.has(o)),
      "a module under src/internal/ that no file under src/ imports. knip cannot see this — it " +
        "treats every test as an entry point — and D3 audits only the declared surface. Wire it, or " +
        "delete it, or add it to KNOWN_TEST_ONLY with the reason it is pending.",
    ).toEqual([]);
  });

  it("the recorded set has not silently grown stale", () => {
    expect(
      [...KNOWN_TEST_ONLY].filter((k) => !orphans.includes(k)),
      "these are recorded as test-only and now have a real importer — delete them from the list, " +
        "which is how the debt actually shrinks",
    ).toEqual([]);
  });
});
