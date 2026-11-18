import { describe, expect, it } from "vitest";
import * as persistence from "../src/persistence.js";

/**
 * SE43 DoD#2 — the shared persistence kernel primitives that published
 * satellites (sdk-cache, sdk-memory, sdk-tools) depend on MUST be reachable
 * from the sanctioned public `./persistence` barrel, so those satellites can
 * stop importing the `internal`-named `./internal/persistence` export
 * (system-design-output/final_report.md § MEDIUM — internal/persistence).
 */

const REQUIRED_PRIMITIVES = [
  "replaceFileAtomic",
  "withCwdMutex",
  "openSqliteResilient",
  "sanitizeFts5Query",
  "PersistenceSchema",
  "atomicWriteText",
  "atomicWriteJson",
] as const;

describe("SE43 DoD#2 — public ./persistence exposes the shared kernel", () => {
  for (const name of REQUIRED_PRIMITIVES) {
    it(`exports ${name}`, () => {
      expect(
        (persistence as Record<string, unknown>)[name],
        `@theokit/sdk/persistence must export ${name}`,
      ).toBeDefined();
    });
  }
});
