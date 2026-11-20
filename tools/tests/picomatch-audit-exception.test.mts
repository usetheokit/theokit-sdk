import { expect, it } from "vitest";
import { readRootFile } from "./lockfile-versions.mts";

/*
 * GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7) is fixed by the patched picomatch copies behind `pnpm.overrides`, so
 * `pnpm-workspace.yaml` must not ignore it. This guard keeps the exception list to the braces
 * advisory and keeps the audit scripts running.
 */

const ADVISORY = "GHSA-fc5q-39xc-vjpf";

// Reads `auditConfig.ignoreGhsas` from the workspace file. No YAML parser is a root dependency, so
// this walks the lines by indentation: `auditConfig:` at column 0, `ignoreGhsas:` one level under
// it, then the `- id` items under that key (inline comments dropped). It throws when either key is
// missing, so a rename fails loudly instead of yielding an empty list.
function ignoredAdvisories(): string[] {
  const lines = readRootFile("pnpm-workspace.yaml")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const indent = (line: string): number => line.length - line.trimStart().length;
  const parent = lines.findIndex((line) => /^auditConfig:\s*(#.*)?$/.test(line));
  if (parent < 0) throw new Error("auditConfig is missing from pnpm-workspace.yaml");
  const key = lines.findIndex(
    (line, i) => i > parent && indent(line) > 0 && /^\s+ignoreGhsas:\s*(#.*)?$/.test(line),
  );
  if (key < 0) throw new Error("auditConfig.ignoreGhsas is missing from pnpm-workspace.yaml");
  const ids: string[] = [];
  for (const line of lines.slice(key + 1)) {
    const item = /^\s+-\s+(\S+)\s*(#.*)?$/.exec(line);
    if (!item || indent(line) < indent(lines[key] as string)) break;
    ids.push(item[1] as string);
  }
  return ids;
}

it("does not ignore the picomatch advisory and ignores nothing beyond the braces one", () => {
  const ignored = ignoredAdvisories();

  expect(ignored).not.toContain(ADVISORY);
  expect(ignored).toEqual(["GHSA-vfj7-8cjw-p6xm"]);
});

it("keeps both audit passes in quality:audit", () => {
  const manifest = JSON.parse(readRootFile("package.json"));
  const script: string = manifest.scripts["quality:audit"];

  expect(script).toContain("pnpm audit --prod --audit-level=low");
  expect(script).toContain("pnpm audit --audit-level=high");
});
