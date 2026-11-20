import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({ failChmod: false }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (sim.failChmod) throw new Error("simulated chmod failure");
      return actual.chmodSync(...args);
    },
  };
});

import { ensureSecureDir, InsecureDirectoryError } from "../../../src/persistence.js";

const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(process.platform === "win32")("ensureSecureDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "secure-dir-"));
  });
  afterEach(() => {
    sim.failChmod = false;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a missing parent as 0700", () => {
    ensureSecureDir(join(tmp, "new", "file.json"));
    expect(mode(join(tmp, "new"))).toBe(0o700);
  });

  it("repairs a 0777 directory to 0700", () => {
    const d = join(tmp, "loose");
    mkdirSync(d);
    chmodSync(d, 0o777);
    ensureSecureDir(join(d, "file.json"));
    expect(mode(d)).toBe(0o700);
  });

  it("throws InsecureDirectoryError when the repair fails", () => {
    const d = join(tmp, "loose");
    mkdirSync(d);
    chmodSync(d, 0o777);
    sim.failChmod = true;
    let err: unknown;
    try {
      ensureSecureDir(join(d, "file.json"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InsecureDirectoryError);
    expect((err as InsecureDirectoryError).code).toBe("insecure_directory");
    expect((err as Error).message).toContain(d);
  });
});
