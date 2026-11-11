import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createImageGenerateTool } from "../src/image-generate.js";
import * as barrel from "../src/index.js";
import { textHandler } from "./text-handler.js";

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "imggen-"));
  outside = mkdtempSync(join(tmpdir(), "imggen-out-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

type Gen = Parameters<typeof createImageGenerateTool>[0]["generate"];
const png =
  (bytes = [1, 2, 3]): Gen =>
  async () => ({
    image: new Uint8Array(bytes),
    mimeType: "image/png",
  });

const run = async (
  generate: Gen,
  input: { prompt: string; filename?: string },
  extra: object = {},
) =>
  JSON.parse(
    await textHandler(createImageGenerateTool({ projectRoot: root, generate, ...extra }))(input),
  ) as Record<string, unknown>;

const noImagesDir = () => expect(existsSync(join(root, "images"))).toBe(false);

describe("createImageGenerateTool", () => {
  it("writes the image under images/ and returns the relative path", async () => {
    const r = await run(png(), { prompt: "red circle", filename: "circle" });
    expect(r).toEqual({ ok: true, path: "images/circle.png", mime_type: "image/png", bytes: 3 });
    expect([...readFileSync(join(root, "images/circle.png"))]).toEqual([1, 2, 3]);
  });
  it("is re-exported from the package root", () => {
    expect(barrel.createImageGenerateTool).toBe(createImageGenerateTool);
  });
  it("derives a stable default stem from the prompt", async () => {
    const a = await run(png(), { prompt: "same" });
    const b = await run(png(), { prompt: "same" });
    expect(a.path).toMatch(/^images\/image-[0-9a-f]{8}\.png$/);
    expect(b.path).toBe(a.path);
  });
  it("turns a provider rejection into generation_failed", async () => {
    const r = await run(
      async () => {
        throw new Error("boom");
      },
      { prompt: "x" },
    );
    expect(r).toEqual({ ok: false, error: "generation_failed", message: "boom" });
    noImagesDir();
  });
  it("refuses a mime type outside the table", async () => {
    const r = await run(async () => ({ image: new Uint8Array([1]), mimeType: "text/html" }), {
      prompt: "x",
    });
    expect(r.error).toBe("unsupported_image_type");
    noImagesDir();
  });
  it("refuses an empty image", async () => {
    expect((await run(png([]), { prompt: "x" })).error).toBe("empty_image");
    noImagesDir();
  });
  it("accepts an image of exactly the limit and refuses one byte more", async () => {
    expect((await run(png([1, 2]), { prompt: "x" }, { maxImageBytes: 2 })).ok).toBe(true);
    const r = await run(png([1, 2, 3]), { prompt: "y" }, { maxImageBytes: 2 });
    expect(r).toEqual({ ok: false, error: "image_too_large", bytes: 3, max_bytes: 2 });
  });
  it("refuses a traversing filename before calling the provider", async () => {
    let called = false;
    const r = await run(
      async () => {
        called = true;
        return { image: new Uint8Array([1]), mimeType: "image/png" };
      },
      { prompt: "x", filename: "../evil" },
    );
    expect(r.error).toBe("path_traversal");
    expect(called).toBe(false);
  });
  it("refuses an oversize prompt", async () => {
    const r = await run(png(), { prompt: "xx" }, { maxPromptChars: 1 });
    expect(r).toEqual({ ok: false, error: "prompt_too_large", chars: 2, max_chars: 1 });
  });
  it("rejects a non-positive ceiling at construction", () => {
    expect(() =>
      createImageGenerateTool({ projectRoot: root, generate: png(), maxImageBytes: 0 }),
    ).toThrow(RangeError);
  });
  it("refuses an output directory that is a symlink out of the root", async () => {
    symlinkSync(outside, join(root, "link"));
    const r = await run(png(), { prompt: "x", filename: "a" }, { outputDir: "link" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(outside, "a.png"))).toBe(false);
  });
  it("reports write_failed with only the errno code", async () => {
    writeFileSync(join(root, "images"), "a file, not a directory");
    mkdirSync(join(root, "unused"));
    const r = await run(png(), { prompt: "x", filename: "a" });
    expect(r.error).toBe("write_failed");
    expect(String(r.message)).not.toContain(root);
  });
});
