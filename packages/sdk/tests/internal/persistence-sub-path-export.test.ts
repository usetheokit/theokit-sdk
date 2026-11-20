/**
 * `@theokit/sdk/internal/persistence` sub-path export smoke test
 * (SDK 2.0 Phase 1 physical Stage 3 prep — iter 32).
 *
 * Per the plan's T1.1 EC-1: sdk-core MUST declare `./internal/persistence`
 * in its `exports` field so extracted packages (sdk-memory, sdk-budget,
 * etc.) can `import` persistence primitives without sdk-core duplication.
 *
 * Without this sub-path, Node ESM blocks consumers with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * This test pins:
 *   - The sub-path resolves at import time (no module-resolution error).
 *   - The expected primitives are exported (withCwdMutex,
 *     atomicWriteJson, withFileLock, etc.) — these are what Stage 3
 *     source-move requires for sdk-memory's rich impl.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";
// `@theokit/sdk/internal/persistence` is no longer published; the supported primitives come from
// the public `persistence` barrel and the internal-only ones from their source modules.
import {
  atomicWriteJson,
  atomicWriteText,
  casUpdate,
  containsCjk,
  createExclusive,
  displayTheokitHome,
  getProfilesRoot,
  getTheokitHome,
  migrateSchema,
  PersistenceSchema,
  readVersionedJson,
  replaceFileAtomic,
  sanitizeFts5Query,
  withCwdMutex,
  withFileLock,
  writeVersionedJson,
} from "../../src/internal/persistence/index.js";

describe("internal/persistence barrel (in-repo only, no longer a published sub-path)", () => {
  // B-061. This file used to open with `test_subpath_resolves_at_import_time`, whose body was
  // `expect(true).toBe(true)`. The repair replaced it with a presence check over all 16 imported
  // names — and review showed every one of those names is already asserted, more strongly
  // (`typeof === "function"`), by the seven tests below. Dropping a symbol from the barrel fails
  // `test_sqlite_helpers_exported` and its siblings, not silently. The test case was therefore
  // redundant in both forms and is gone; the module-level import above is what proves the sub-path
  // resolves, and it runs before any test in this file.

  it("test_cwd_mutex_exported_for_extracted_packages", () => {
    expect(typeof withCwdMutex).toBe("function");
    // Signature: <T>(key, fn) => Promise<T>
    expectTypeOf(withCwdMutex).toBeFunction();
  });

  it("test_atomic_write_primitives_exported", () => {
    expect(typeof atomicWriteJson).toBe("function");
    expect(typeof atomicWriteText).toBe("function");
    expect(typeof replaceFileAtomic).toBe("function");
  });

  it("test_file_lock_exported", () => {
    expect(typeof withFileLock).toBe("function");
    expect(typeof createExclusive).toBe("function");
  });

  it("test_versioned_json_helpers_exported", () => {
    expect(typeof readVersionedJson).toBe("function");
    expect(typeof writeVersionedJson).toBe("function");
    expect(typeof migrateSchema).toBe("function");
    expect(PersistenceSchema).toBeDefined();
  });

  it("test_path_helpers_exported", () => {
    expect(typeof getTheokitHome).toBe("function");
    expect(typeof getProfilesRoot).toBe("function");
    expect(typeof displayTheokitHome).toBe("function");
  });

  it("test_fts5_helpers_exported", () => {
    expect(typeof sanitizeFts5Query).toBe("function");
    expect(typeof containsCjk).toBe("function");
  });

  it("test_sqlite_helpers_exported", () => {
    expect(typeof casUpdate).toBe("function");
  });
});

describe("the published transcript helpers and the SessionStore port point at each other", () => {
  const read = (rel: string): string =>
    readFileSync(join(__dirname, "..", "..", "src", rel), "utf8");

  /**
   * An audit read `transcriptPath` being a published export as the storage
   * detail escaping the `SessionStore` port — a Repository that does not hide
   * what it abstracts. The port never claimed to: it speaks the native
   * `SessionRecord` by design, and the layout helpers are published so a
   * consumer can find a transcript file.
   *
   * Both facts are true and only dangerous apart, so each file states the
   * relationship and this pins the pair together. It checks that the
   * cross-reference EXISTS, not that either prose is correct — an inversion a
   * script cannot judge, and saying so is the point.
   */
  it("persistence.ts explains why the path helpers are not a leak", () => {
    const persistence = read("persistence.ts");
    expect(persistence).toContain("types/session-store.ts");
    expect(persistence).toContain("local.sessionStore");
  });

  it("the port says it does not hide the layout, and where the layout is published", () => {
    const port = read("types/session-store.ts");
    expect(port).toContain("DOES NOT HIDE THE STORAGE");
    expect(port).toContain("@theokit/sdk/persistence");
  });
});
