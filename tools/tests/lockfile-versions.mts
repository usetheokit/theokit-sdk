import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Shared by the advisory guards in this directory. Each guard reads the files that decide which
 * version of a package gets installed (the root override and pnpm-lock.yaml) and fails offline
 * when a version below the advisory's fix could come back. `pnpm audit` cannot do that job: it
 * needs the registry.
 */

export type Version = readonly [number, number, number];

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function readRootFile(name: string): string {
  return readFileSync(resolve(ROOT, name), "utf8");
}

// Only `X.Y.Z` or `^X.Y.Z`, with nothing around it. Any other shape (a pre-release, a range, a
// wildcard) yields no version, and every caller treats that as unpatched, so a value the guard
// cannot read fails it instead of passing because nothing parsed.
export function versionParts(value: string): Version | undefined {
  const match = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function isAtLeast(version: Version | undefined, floor: Version): boolean {
  return version !== undefined && compareVersions(version, floor) >= 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Package and snapshot keys sit at a two-space indent as `name@<version>:` or `name@<version>(`,
// quoted when the name is scoped (`'@scope/name@1.2.3':`). Everything between the `@` and the
// first `(`, `:` or quote is returned as written, pre-release suffix included, so the caller sees
// a version it cannot read rather than never seeing it. The `overrides:` header (`  name: ^X`) has
// no `@`, importer entries sit deeper, and `name-other@...` has a `-` where the `@` must be.
export function resolvedVersions(lockfile: string, packageName: string): string[] {
  const key = new RegExp(`^ {2}'?${escapeRegExp(packageName)}@([^('":\\s]+)['(:]`, "gm");
  return [...lockfile.matchAll(key)].map((match) => match[1]);
}
