import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ breakChmod: false }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (state.breakChmod) throw new Error("EPERM simulated");
      return actual.chmodSync(...args);
    },
  };
});

import { ensureSecureDir, InsecureDirectoryError } from "../../../src/persistence.js";

const posix = process.platform !== "win32";

describe.skipIf(!posix)("ensureSecureDir", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "secure-dir-"));
    state.breakChmod = false;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates a missing parent as 0700", () => {
    ensureSecureDir(join(root, "new", "file.json"));
    expect(statSync(join(root, "new")).mode & 0o777).toBe(0o700);
  });

  it("repairs a 0777 directory to 0700", () => {
    const dir = join(root, "loose");
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    ensureSecureDir(join(dir, "f.json"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("throws InsecureDirectoryError when the repair fails", () => {
    const dir = join(root, "stuck");
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    state.breakChmod = true;
    let caught: unknown;
    try {
      ensureSecureDir(join(dir, "f.json"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InsecureDirectoryError);
    expect((caught as InsecureDirectoryError).code).toBe("insecure_directory");
    expect((caught as Error).message).toContain(dir);
  });
});
