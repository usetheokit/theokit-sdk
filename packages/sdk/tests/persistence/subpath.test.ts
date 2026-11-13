/**
 * `@theokit/sdk/persistence` public sub-path contract test (V2-3, T1.1/T1.2).
 *
 * Pins the STABLE public surface promoted from `internal/persistence`:
 *   - the sub-path source resolves + exports the consumer-grade cluster
 *   - one behavior round-trip each (jsonl persist→resume, atomic write→read)
 *
 * Imports from `../../src/persistence.js` (source, like `retry.test.ts`).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendJsonl,
  applyWalWithFallback,
  atomicWriteJson,
  atomicWriteText,
  isCorruptionError,
  JsonlParseError,
  loadJsonl,
  openSqliteResilient,
  readJsonlIds,
  replaceFileAtomic,
  withFileLock,
} from "../../src/persistence.js";

describe("@theokit/sdk/persistence public sub-path", () => {
  it("test_persistence_subpath_exports_the_consumer_cluster", () => {
    for (const fn of [
      appendJsonl,
      readJsonlIds,
      loadJsonl,
      replaceFileAtomic,
      atomicWriteText,
      atomicWriteJson,
      withFileLock,
      openSqliteResilient,
      applyWalWithFallback,
      isCorruptionError,
    ]) {
      expect(typeof fn).toBe("function");
    }
    expect(JsonlParseError.prototype).toBeInstanceOf(Error);
  });

  it("test_jsonl_append_then_resume_roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "persist-jsonl-"));
    try {
      const f = join(dir, "sub", "preds.jsonl"); // sub/ absent → appendJsonl mkdirs
      appendJsonl(f, { id: "a", patch: "diff-a" });
      appendJsonl(f, { id: "b", patch: "" }); // empty → not "done"
      appendJsonl(f, { id: "c", patch: "diff-c" });
      const done = readJsonlIds(f, (p) =>
        typeof p.id === "string" && typeof p.patch === "string" && p.patch.length > 0
          ? p.id
          : undefined,
      );
      expect([...done].sort()).toEqual(["a", "c"]);
      expect(loadJsonl(f).length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test_atomic_write_then_read_back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "persist-atomic-"));
    try {
      const f = join(dir, "cfg.txt");
      await replaceFileAtomic(f, "hello");
      expect(readFileSync(f, "utf8")).toBe("hello");
      await atomicWriteText(f, "world");
      expect(readFileSync(f, "utf8")).toBe("world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
