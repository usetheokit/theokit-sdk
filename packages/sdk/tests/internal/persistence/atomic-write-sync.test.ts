import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJson, atomicWriteJsonSync } from "../../../src/persistence.js";

describe("atomicWriteJsonSync / dirMode", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-sync-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes content with the requested mode and leaves no temp", () => {
    const path = join(dir, "a.json");
    atomicWriteJsonSync(path, { a: 1 }, { mode: 0o600 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("throws TypeError for undefined and leaves no temp", () => {
    expect(() => atomicWriteJsonSync(join(dir, "u.json"), undefined)).toThrow(TypeError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cleans the temp when the rename fails", () => {
    // target is a directory, so rename of a file over it fails
    const target = join(dir, "t");
    atomicWriteJsonSync(join(target, "x.json"), {});
    expect(() => atomicWriteJsonSync(target, {})).toThrow();
    expect(readdirSync(dir)).toEqual(["t"]);
  });

  it.skipIf(process.platform === "win32")(
    "atomicWriteJson dirMode creates parent 0700",
    async () => {
      await atomicWriteJson(join(dir, "p", "f.json"), {}, { dirMode: 0o700 });
      expect(statSync(join(dir, "p")).mode & 0o777).toBe(0o700);
    },
  );
});
