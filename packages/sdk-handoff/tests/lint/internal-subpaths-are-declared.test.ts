import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HEADING = "## What `internal` means here";

function internalSubpaths(exportsField: Record<string, unknown>): string[] {
  return Object.keys(exportsField).filter((k) => k.startsWith("./internal/"));
}

/** Only the declaring section counts; an unrelated mention elsewhere must not satisfy the gate. */
function declaringSection(readme: string): string {
  const start = readme.indexOf(HEADING);
  if (start === -1) return "";
  const rest = readme.slice(start + HEADING.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

function undeclared(exportsField: Record<string, unknown>, readme: string): string[] {
  const section = declaringSection(readme);
  return internalSubpaths(exportsField).filter(
    (p) => !section.includes(`\`${p.replace("./internal/", "")}\``),
  );
}

describe("every published internal subpath is declared in the README", () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");

  it("reads a non-empty manifest and declaring section", () => {
    expect(declaringSection(readme)).toContain("no compatibility promise");
    expect(internalSubpaths(manifest.exports).length).toBeGreaterThanOrEqual(1);
  });

  it("names each ./internal/* subpath in the README section", () => {
    expect(undeclared(manifest.exports, readme)).toEqual([]);
  });

  it("reports a fake ./internal/x entry as undeclared", () => {
    const fake = { ...manifest.exports, "./internal/x": {} };
    expect(undeclared(fake, readme)).toEqual(["./internal/x"]);
  });
});
