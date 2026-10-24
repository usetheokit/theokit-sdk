import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/*
 * GHSA-mrhx-c7xc-m3w5: zod below 4.6.6 can exhaust memory on crafted input. The root override
 * held this workspace's lockfile at zod 4.6.2, so both halves of `quality:audit` failed CI.
 *
 * The audit cannot serve as the regression test, because it needs the registry. This test reads
 * the two local files that decide which zod gets installed (the root override and the lockfile)
 * and fails offline when either one lets a zod below the fix back in.
 */

type Version = readonly [number, number, number];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PATCHED: Version = [4, 6, 6];

// Only `X.Y.Z` or `^X.Y.Z`, with nothing around it. Any other shape yields no version, so the
// override test fails on a value it cannot read instead of passing because nothing parsed.
function versionParts(value: string): Version | undefined {
  const match = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function isPatched4x(version: Version | undefined): boolean {
  return version !== undefined && version[0] === 4 && compareVersions(version, PATCHED) >= 0;
}

// Package and snapshot keys sit at a two-space indent as `zod@X.Y.Z:` or `zod@X.Y.Z(`. The
// `overrides:` header (`  zod: ^4.6.6`) has no `@`, importer entries sit deeper, and
// `zod-to-json-schema@...` has a `-` where the `@` must be, so none of them is collected.
function resolvedZodVersions(lockfile: string): string[] {
  return [...lockfile.matchAll(/^ {2}zod@(\d+\.\d+\.\d+)[(:]/gm)].map((match) => match[1]);
}

it("the root override admits no zod below the memory exhaustion fix", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const override: unknown = manifest.pnpm?.overrides?.zod;

  expect(typeof override, "pnpm.overrides.zod is missing from the root package.json").toBe(
    "string",
  );
  expect(
    isPatched4x(versionParts(override as string)),
    `override is ${String(override)}; it must be ^X.Y.Z at or above 4.6.6 within 4.x`,
  ).toBe(true);
});

it("every zod the lockfile resolves is past the memory exhaustion advisory", () => {
  const versions = resolvedZodVersions(readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8"));

  expect(versions.length, "pnpm-lock.yaml resolves no zod at all").toBeGreaterThan(0);
  expect(versions.filter((version) => !isPatched4x(versionParts(version)))).toEqual([]);
});

it("the version comparison ranks 4.6.10 above 4.6.6 and 4.7.0 above 4.6.99", () => {
  expect(isPatched4x(versionParts("4.6.10"))).toBe(true);
  expect(isPatched4x(versionParts("4.7.0"))).toBe(true);
  expect(compareVersions([4, 7, 0], [4, 6, 99])).toBeGreaterThan(0);
  expect(isPatched4x(versionParts("4.6.5"))).toBe(false);
  expect(isPatched4x(versionParts("5.0.0"))).toBe(false);
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

  expect(resolvedZodVersions(fixture)).toEqual(["4.6.7"]);
});
