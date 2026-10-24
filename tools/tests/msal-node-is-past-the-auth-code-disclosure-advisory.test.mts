import { expect, it } from "vitest";
import {
  isAtLeast,
  readRootFile,
  resolvedVersions,
  type Version,
  versionParts,
} from "./lockfile-versions.mts";

/*
 * GHSA-xcx6-jx8p-x3h5 (high): @azure/msal-node from 5.0.0-beta.0 up to 7.1.0 may disclose
 * authorization code flow parameters to an attacker-controlled endpoint. It reaches this workspace
 * only through packages/memory-mem0 > mem0ai > @azure/identity, whose newest release still asks for
 * an msal-node below the fix, so a root override is what moves it. Until the override existed the
 * lockfile held 5.6.0 and `pnpm audit --audit-level=high` failed `quality:audit`.
 *
 * Like the zod guard, this reads the lockfile and runs offline: the audit needs the registry.
 */

const PATCHED: Version = [7, 1, 0];

function isBelowTheFix(value: string): boolean {
  return !isAtLeast(versionParts(value), PATCHED);
}

it("every @azure/msal-node the lockfile resolves is past the auth code disclosure advisory", () => {
  const versions = resolvedVersions(readRootFile("pnpm-lock.yaml"), "@azure/msal-node");

  expect(versions.length, "pnpm-lock.yaml resolves no @azure/msal-node at all").toBeGreaterThan(0);
  expect(versions.filter(isBelowTheFix), "@azure/msal-node below 7.1.0, or unreadable").toEqual(
    [],
  );
});

it("the lockfile scan reads a quoted scoped key and skips a sibling package", () => {
  const fixture = [
    "packages:",
    "  '@azure/msal-common@16.14.2':",
    "  '@azure/msal-node@7.1.1':",
    "  '@azure/msal-node-extensions@1.0.0':",
    "snapshots:",
    "  '@azure/msal-node@7.1.1':",
    "",
  ].join("\n");

  expect(resolvedVersions(fixture, "@azure/msal-node")).toEqual(["7.1.1", "7.1.1"]);
});

it("an msal-node below 7.1.0 is below the fix", () => {
  expect(isBelowTheFix("7.0.2")).toBe(true);
  expect(isBelowTheFix("5.6.0")).toBe(true);
  expect(isBelowTheFix("7.1.0")).toBe(false);
});
