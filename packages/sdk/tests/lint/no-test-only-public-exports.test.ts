import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORBIDDEN = /ForTests?$|^__?reset/;

// Narrow, per-entry exemption (NOT granted by the issue; flagged for the owner). The semver-exempt
// `./internal/memory-store` shared-kernel channel re-exports `resetMigrationStateForTests`, and
// @theokit/sdk-memory re-exports and tests through it. Removing it needs a satellite change first.
// It is exempt only on that one entry; any other entry resolving it fails.
const ALLOWED_BY_ENTRY: Record<string, string> = {
  "./internal/memory-store": "resetMigrationStateForTests",
};

type Conditions = { types?: string } | string;
function declarationFiles(exportsMap: Record<string, unknown>): Map<string, string> {
  const files = new Map<string, string>(); // declaration file -> entry key
  for (const [key, entry] of Object.entries(exportsMap)) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const cond of Object.values(entry as Record<string, Conditions>)) {
      if (typeof cond === "object" && cond.types) files.set(cond.types, key);
    }
  }
  return files;
}

function exportedNames(files: string[]): Map<string, string[]> {
  const program = ts.createProgram(files, {
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const out = new Map<string, string[]>();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    const sym = sf && checker.getSymbolAtLocation(sf);
    out.set(file, sym ? checker.getExportsOfModule(sym).map((s) => s.getName()) : []);
  }
  return out;
}

function isOffender(name: string, entry: string | undefined): boolean {
  return FORBIDDEN.test(name) && ALLOWED_BY_ENTRY[entry ?? ""] !== name;
}

function findOffenders(names: Map<string, string[]>, entryByFile: Map<string, string>): string[] {
  return [...names].flatMap(([file, list]) =>
    list.filter((n) => isOffender(n, entryByFile.get(file))).map((n) => `${file}: ${n}`),
  );
}

describe("no published entry resolves a test-only export", () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  const entryByFile = new Map(
    [...declarationFiles(manifest.exports)].map(([f, k]) => [resolve(PKG_ROOT, f), k]),
  );
  const files = [...entryByFile.keys()];

  it("every declared .d.ts / .d.cts exists (build the package first)", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !existsSync(f))).toEqual([]);
  });

  it("no export name matches the test-only pattern", () => {
    expect(findOffenders(exportedNames(files), entryByFile)).toEqual([]);
  });
});
