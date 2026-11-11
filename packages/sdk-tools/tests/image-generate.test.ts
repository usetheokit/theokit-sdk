import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImageGenerateTool } from "../src/image-generate.js";
import * as barrel from "../src/index.js";
import { textHandler } from "./text-handler.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "imggen-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = async (
  generate: Parameters<typeof createImageGenerateTool>[0]["generate"],
  input: { prompt: string; filename?: string },
  extra: object = {},
) =>
  JSON.parse(
    await textHandler(createImageGenerateTool({ projectRoot: root, generate, ...extra }))(input),
  ) as Record<string, unknown>;

describe("createImageGenerateTool", () => {
  it("writes the image under images/ and returns the relative path", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await run(async () => ({ image: bytes, mimeType: "image/png" }), {
      prompt: "red circle",
      filename: "circle",
    });
    expect(r).toEqual({ ok: true, path: "images/circle.png", mime_type: "image/png", bytes: 3 });
    expect([...readFileSync(join(root, "images/circle.png"))]).toEqual([1, 2, 3]);
    expect(barrel.createImageGenerateTool).toBe(createImageGenerateTool);
  });
  it("reports provider failure, bad type, traversal and oversize without writing", async () => {
    const ok = async () => ({ image: new Uint8Array([1]), mimeType: "image/png" });
    expect(
      (
        await run(
          async () => {
            throw new Error("boom");
          },
          { prompt: "x" },
        )
      ).error,
    ).toBe("generation_failed");
    expect(
      (
        await run(async () => ({ image: new Uint8Array([1]), mimeType: "text/html" }), {
          prompt: "x",
        })
      ).error,
    ).toBe("unsupported_image_type");
    expect((await run(ok, { prompt: "x", filename: "../evil" })).error).toBe("path_traversal");
    expect((await run(ok, { prompt: "xx" }, { maxPromptChars: 1 })).error).toBe("prompt_too_large");
    expect(
      (await run(ok, { prompt: "x" }, { maxImageBytes: 0.5 }).catch(() => ({ error: "range" })))
        .error,
    ).toBe("range");
    expect(existsSync(join(root, "images"))).toBe(false);
  });
});
