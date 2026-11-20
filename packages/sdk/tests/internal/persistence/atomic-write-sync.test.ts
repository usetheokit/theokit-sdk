import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJsonSync, atomicWriteTempTarget } from "../../../src/persistence.js";

describe("atomicWriteJsonSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-sync-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content with the requested mode and leaves no temp", () => {
    const path = join(dir, "a.json");
    atomicWriteJsonSync(path, { a: 1 }, { mode: 0o600 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => atomicWriteTempTarget(n) !== undefined)).toEqual([]);
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("throws TypeError for undefined and leaves no temp", () => {
    expect(() => atomicWriteJsonSync(join(dir, "b.json"), undefined)).toThrow(TypeError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the temp when the rename fails", () => {
    // target is a directory, so rename fails after the temp was written
    const target = join(dir, "t");
    atomicWriteJsonSync(join(target, "x.json"), {});
    expect(() => atomicWriteJsonSync(target, {})).toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM/);
    expect(readdirSync(dir)).toEqual(["t"]);
  });

  it("creates a missing parent with dirMode", () => {
    atomicWriteJsonSync(join(dir, "n", "c.json"), 1, { dirMode: 0o700 });
    if (process.platform !== "win32") expect(statSync(join(dir, "n")).mode & 0o777).toBe(0o700);
  });
});
