/**
 * #1111: the root entry does not export the test-only `resetMigrationStateForTests`.
 * `pnpm build` must precede this file: it resolves `dist/index.d.ts` with the TypeScript checker.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.d.ts");

function exportedNames(): string[] {
  const program = ts.createProgram([entry], { skipLibCheck: true, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`cannot load ${entry}`);
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error("dist/index.d.ts has no module symbol");
  return checker.getExportsOfModule(symbol).map((s) => s.getName());
}

describe("root entry exports", () => {
  it("does not resolve resetMigrationStateForTests, keeps the public migration API", () => {
    const names = exportedNames();
    expect(names).not.toContain("resetMigrationStateForTests");
    expect(names).toContain("migrateLegacyJson");
    expect(names).toContain("MigrationResult");
  });
});
