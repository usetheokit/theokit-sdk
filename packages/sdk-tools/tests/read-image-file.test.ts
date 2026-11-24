import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readImageFile } from "../src/index.js";

vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "img-"));
  vi.mocked(fs.readFileSync).mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readImageFile", () => {
  it("reads a supported image", () => {
    const p = join(dir, "a.PNG");
    writeFileSync(p, Buffer.from([1, 2, 3]));
    expect(readImageFile(p)).toEqual({ ok: true, data: "AQID", mediaType: "image/png", bytes: 3 });
  });

  it("accepts a file of exactly maxBytes, refuses one byte over without reading", () => {
    const p = join(dir, "a.png");
    writeFileSync(p, Buffer.alloc(10));
    expect(readImageFile(p, { maxBytes: 10 }).ok).toBe(true);
    vi.mocked(fs.readFileSync).mockClear();
    expect(readImageFile(p, { maxBytes: 9 })).toMatchObject({
      ok: false,
      error: "image_too_large",
      bytes: 10,
      limit_bytes: 9,
    });
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("refuses unsupported extensions", () => {
    expect(readImageFile(join(dir, "a.bmp"))).toMatchObject({ error: "unsupported_type" });
  });

  it("reports a missing file as not_found", () => {
    expect(readImageFile(join(dir, "nope.png"))).toMatchObject({ error: "not_found" });
  });

  it("reports a directory named x.png as unreadable", () => {
    const p = join(dir, "x.png");
    mkdirSync(p);
    const r = readImageFile(p);
    expect(r).toMatchObject({ ok: false, error: "unreadable" });
  });
});
