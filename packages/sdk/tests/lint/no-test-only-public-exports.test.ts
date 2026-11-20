import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORBIDDEN = /ForTests?$|^__?reset/;

// `resetMigrationStateForTests` is re-exported by the semver-exempt `./internal/memory/storage`
// shared-kernel channel, which @theokit/sdk-memory consumes and tests through. It is outside this
// issue's scope; removing it means changing the satellite first, so it is allowlisted by name.
const ALLOWED = new Set(["resetMigrationStateForTests"]);

type Conditions = { types?: string } | string;
function declarationFiles(exportsMap: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const entry of Object.values(exportsMap)) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const cond of Object.values(entry as Record<string, Conditions>)) {
      if (typeof cond === "object" && cond.types) files.push(cond.types);
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

describe("no published entry resolves a test-only export", () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  const files = declarationFiles(manifest.exports).map((f) => resolve(PKG_ROOT, f));

  it("every declared .d.ts / .d.cts exists (build the package first)", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !existsSync(f))).toEqual([]);
  });

  it("no export name matches the test-only pattern", () => {
    const offenders: string[] = [];
    for (const [file, names] of exportedNames(files)) {
      for (const n of names)
        if (FORBIDDEN.test(n) && !ALLOWED.has(n)) offenders.push(`${file}: ${n}`);
    }
    expect(offenders).toEqual([]);
  });
});
