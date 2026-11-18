import { expect, it } from "vitest";
import { readRootFile } from "./lockfile-versions.mts";

/*
 * GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7) has no patched release, so `quality:audit` ignores it in
 * `pnpm-workspace.yaml`. This guard keeps that exception to this one advisory and keeps the audit
 * scripts running, so it cannot grow into a blanket ignore.
 */

const ADVISORY = "GHSA-fc5q-39xc-vjpf";

function ignoredAdvisories(): string[] {
  const workspace = readRootFile("pnpm-workspace.yaml");
  const block = /^ignoreGhsas:\n((?: {2,}.*\n?)*)/m.exec(workspace.replace(/^auditConfig:\n/m, ""));
  const items = block?.[1] ?? "";
  return [...items.matchAll(/^\s+-\s+(GHSA-[\w-]+)/gm)].map((m) => m[1] as string);
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
