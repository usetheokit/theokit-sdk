import { expect, it } from "vitest";
import { readRootFile } from "./lockfile-versions.mts";

/*
 * GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7) has no patched release, so `quality:audit` ignores it in
 * `pnpm-workspace.yaml`. This guard keeps that exception to this one advisory and keeps the audit
 * scripts running, so it cannot grow into a blanket ignore.
 */

const ADVISORY = "GHSA-fc5q-39xc-vjpf";

// Every `- GHSA-...` list item in the workspace file. Comment lines start with `#`, so a GHSA id
// mentioned in a comment is not collected. The file's only list of GHSA ids is `ignoreGhsas`.
function ignoredAdvisories(): string[] {
  const workspace = readRootFile("pnpm-workspace.yaml");
  return [...workspace.matchAll(/^\s+-\s+(GHSA-[\w-]+)\s*$/gm)].map((m) => m[1] as string);
}

it("ignores the picomatch advisory and no unreviewed advisory beyond the known ones", () => {
  const ignored = ignoredAdvisories();

  expect(ignored).toContain(ADVISORY);
  expect(ignored).toEqual(["GHSA-vfj7-8cjw-p6xm", ADVISORY]);
});

it("keeps both audit passes in quality:audit", () => {
  const manifest = JSON.parse(readRootFile("package.json"));
  const script: string = manifest.scripts["quality:audit"];

  expect(script).toContain("pnpm audit --prod --audit-level=low");
  expect(script).toContain("pnpm audit --audit-level=high");
});
