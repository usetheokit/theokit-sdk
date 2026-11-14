import { describe, expect, it } from "vitest";
import * as alias from "../../src/internal/persistence/index.js";

/**
 * SE43 DoD#2 / EC-1 — the deprecated `@theokit/sdk/internal/persistence` alias MUST
 * keep re-exporting its FULL current surface for one release, so external consumers
 * that import internal-only primitives do NOT break silently. The alias is marked
 * `@deprecated` (import from the sanctioned `@theokit/sdk/persistence` instead) but
 * is NOT shrunk to the public subset — the internal barrel exports a superset
 * (`createExclusive`, `casUpdate`, `appendJsonl`, `getTheokitHome`, … are internal-only).
 */

// Symbols on the public ./persistence barrel (the migration target).
const PUBLIC_SUBSET = [
  "replaceFileAtomic",
  "atomicWriteText",
  "atomicWriteJson",
  "withCwdMutex",
  "sanitizeFts5Query",
  "PersistenceSchema",
  "openSqliteResilient",
] as const;

// Internal-ONLY symbols — these would VANISH if the alias were shrunk to the public
// barrel. Their presence is the EC-1 back-compat guarantee.
const INTERNAL_ONLY = [
  "createExclusive",
  "casUpdate",
  "appendJsonl",
  "loadJsonl",
  "readJsonlIds",
  "getTheokitHome",
  "getProfilesRoot",
  "containsCjk",
] as const;

describe("SE43 DoD#2 / EC-1 — deprecated alias preserves its full surface", () => {
  for (const name of [...PUBLIC_SUBSET, ...INTERNAL_ONLY]) {
    it(`still exports ${name}`, () => {
      expect(
        (alias as Record<string, unknown>)[name],
        `@theokit/sdk/internal/persistence must still export ${name} (EC-1 back-compat)`,
      ).toBeDefined();
    });
  }
});
