import { describe, expect, it } from "vitest";
import { generateImage } from "../src/generate-image.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64");
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
    expect(r.image.length).toBe(9);
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
  it("labels non-image bytes as octet-stream so the tool can refuse them", async () => {
    const junk = Buffer.from("hello").toString("base64");
    const r = await generateImage({
      prompt: "x",
      apiKey: "k",
      fetch: ok({ data: [{ b64_json: junk }] }),
    });
    expect(r.mimeType).toBe("application/octet-stream");
  });
  it("chatgpt route reads the image from the SSE stream", async () => {
    let url = "";
    const f = (async (u: string) => {
      url = u;
      const ev = {
        type: "response.output_item.done",
        item: { type: "image_generation_call", result: png },
      };
      return new Response(`event: x\ndata: {"type":"other"}\n\ndata: ${JSON.stringify(ev)}\n\n`);
    }) as unknown as typeof fetch;
    const r = await generateImage({ prompt: "x", route: "chatgpt", fetch: f });
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(r.mimeType).toBe("image/png");
    const none = (async () => new Response("data: {}\n")) as unknown as typeof fetch;
    await expect(generateImage({ prompt: "x", route: "chatgpt", fetch: none })).rejects.toThrow(
      /no image/,
    );
  });
});
