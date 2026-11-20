import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicPersistence from "../src/persistence.js";

/**
 * The deprecated `@theokit/sdk/internal/persistence` alias was removed in the next major. Its
 * replacement is the sanctioned `@theokit/sdk/persistence` barrel, which must keep exporting the
 * supported subset, and the manifest must no longer publish the old subpath.
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PUBLIC_SUBSET = [
  "replaceFileAtomic",
  "atomicWriteText",
  "atomicWriteJson",
  "withCwdMutex",
  "sanitizeFts5Query",
  "PersistenceSchema",
] as const;

describe("internal/persistence alias removal", () => {
  for (const name of PUBLIC_SUBSET) {
    it(`the public persistence barrel exports ${name}`, () => {
      expect((publicPersistence as Record<string, unknown>)[name]).toBeDefined();
    });
  }

  it("package.json no longer publishes ./internal/persistence", () => {
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).not.toContain("./internal/persistence");
  });
});
