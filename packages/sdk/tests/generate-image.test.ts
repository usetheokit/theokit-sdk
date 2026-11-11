import { describe, expect, it } from "vitest";
import { generateImage } from "../src/generate-image.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString("base64");
const ok = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("generateImage", () => {
  it("decodes the first image and posts the prompt", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
    }) as unknown as typeof fetch;
    const r = await generateImage({ prompt: "red circle", apiKey: "k", fetch: f });
    expect(r.mimeType).toBe("image/png");
    expect(r.image.length).toBe(6);
    expect(seen?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(seen?.init.body)).prompt).toBe("red circle");
  });
  it("rejects on status, empty data and missing key", async () => {
    await expect(generateImage({ prompt: "x", apiKey: "k", fetch: ok({}, 500) })).rejects.toThrow(
      /500/,
    );
    await expect(
      generateImage({ prompt: "x", apiKey: "k", fetch: ok({ data: [] }) }),
    ).rejects.toThrow(/no image/);
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(generateImage({ prompt: "x" })).rejects.toThrow(/API key/);
    if (saved) process.env.OPENAI_API_KEY = saved;
  });
});
