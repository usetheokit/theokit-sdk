import { expect, it } from "vitest";
import {
  compareVersions,
  isAtLeast,
  readRootFile,
  resolvedVersions,
  type Version,
  versionParts,
} from "./lockfile-versions.mts";

/*
 * GHSA-mrhx-c7xc-m3w5: zod below 4.6.6 can exhaust memory on crafted input. The root override
 * held this workspace's lockfile at zod 4.6.2, so both halves of `quality:audit` failed CI.
 *
 * The audit cannot serve as the regression test, because it needs the registry. This test reads
 * the two local files that decide which zod gets installed (the root override and the lockfile)
 * and fails offline when either one lets a zod below the fix back in.
 *
 * Two policies are checked apart, so a failure names the one that broke: the advisory floor
 * (at or above 4.6.6) and the major this workspace is on (4.x). A deliberate move to zod 5 fails
 * the major check, not the advisory one.
 */

const PATCHED: Version = [4, 6, 6];
const MAJOR = 4;

function isBelowTheFix(value: string): boolean {
  return !isAtLeast(versionParts(value), PATCHED);
}

function isOutsideTheMajor(value: string): boolean {
  return versionParts(value)?.[0] !== MAJOR;
}

it("the root override admits no zod below the memory exhaustion fix", () => {
  const manifest = JSON.parse(readRootFile("package.json"));
  const override: unknown = manifest.pnpm?.overrides?.zod;

  expect(typeof override, "pnpm.overrides.zod is missing from the root package.json").toBe(
    "string",
  );
  expect(
    isBelowTheFix(override as string),
    `override is ${String(override)}; it must be ^X.Y.Z at or above 4.6.6`,
  ).toBe(false);
  expect(
    isOutsideTheMajor(override as string),
    `override is ${String(override)}; this workspace is on zod 4.x`,
  ).toBe(false);
});

it("every zod the lockfile resolves is past the memory exhaustion advisory", () => {
  const versions = resolvedVersions(readRootFile("pnpm-lock.yaml"), "zod");

  expect(versions.length, "pnpm-lock.yaml resolves no zod at all").toBeGreaterThan(0);
  expect(versions.filter(isBelowTheFix), "zod below 4.6.6, or unreadable").toEqual([]);
  expect(versions.filter(isOutsideTheMajor), "zod outside 4.x").toEqual([]);
});

it("two-digit patch and minor versions rank above the fix", () => {
  expect(isBelowTheFix("4.6.10")).toBe(false);
  expect(isBelowTheFix("4.7.0")).toBe(false);
  expect(compareVersions([4, 7, 0], [4, 6, 99])).toBeGreaterThan(0);
});

it("a version below 4.6.6 is below the fix", () => {
  expect(isBelowTheFix("4.6.5")).toBe(true);
});

it("a zod outside 4.x fails the major check", () => {
  expect(isOutsideTheMajor("5.0.0")).toBe(true);
  expect(isOutsideTheMajor("3.25.0")).toBe(true);
});

it("an unreadable override value yields no parsed version", () => {
  for (const value of [">=4.6.6", "4.x", "*", "^4.6.6-beta.1", " ^4.6.6", ""]) {
    expect(versionParts(value), `parsed ${JSON.stringify(value)}`).toBeUndefined();
  }
});

it("the lockfile scan returns only resolved zod keys", () => {
  const fixture = [
    "overrides:",
    "  zod: ^4.6.6",
    "importers:",
    "  packages/sdk:",
    "    dependencies:",
    "      zod:",
    "        specifier: ^4.0.0",
    "        version: 4.6.7",
    "packages:",
    "  zod-to-json-schema@3.25.2(zod@4.6.7):",
    "  zod@4.6.7:",
    "",
  ].join("\n");

  expect(resolvedVersions(fixture, "zod")).toEqual(["4.6.7"]);
});

it("the lockfile scan reports a pre-release zod key instead of skipping it", () => {
  const fixture = ["packages:", "  zod@4.6.5-beta.1:", "  zod@4.6.7:", ""].join("\n");

  expect(resolvedVersions(fixture, "zod")).toEqual(["4.6.5-beta.1", "4.6.7"]);
});

it("a pre-release zod key counts as below the fix", () => {
  expect(isBelowTheFix("4.6.6-beta.1")).toBe(true);
});
