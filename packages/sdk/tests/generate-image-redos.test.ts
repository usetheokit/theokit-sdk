import { expect, it } from "vitest";
import { generateImage } from "../src/generate-image.js";

/**
 * CodeQL `js/polynomial-redos` on `generateImage`: `baseUrl` is caller input, and it was trimmed
 * with `/\/+$/`. On a run of slashes followed by anything else the engine backtracks at every
 * start position, which is quadratic in the length of the run (see model-option-redos.test.ts for
 * the measured curve of the same regex).
 */

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64");
const capture = () => {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
  }) as unknown as typeof globalThis.fetch;
  return { urls, fetch };
};

it("takes a pathological baseUrl without stalling", async () => {
  const { fetch } = capture();
  const hostile = `https://x.test/${"/".repeat(100_000)}a`;

  const started = Date.now();
  await generateImage({ prompt: "x", apiKey: "k", baseUrl: hostile, fetch });
  const elapsed = Date.now() - started;

  // Loose on purpose: "not quadratic", not a benchmark.
  expect(elapsed).toBeLessThan(1_000);
});

it("still strips the trailing slashes of a baseUrl", async () => {
  const { urls, fetch } = capture();
  await generateImage({ prompt: "x", apiKey: "k", baseUrl: "https://x.test/v1///", fetch });
  expect(urls[0]).toBe("https://x.test/v1/images/generations");
});
