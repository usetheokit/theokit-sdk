/**
 * #1067: the ten embedding adapters have ONE implementation. The objects exported by the built
 * `@theokit/sdk-memory` are the same references as those of `@theokit/sdk/internal/memory-adapters`.
 * `pnpm build` of both packages must precede this file.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const sharedUrl = new URL("../dist/internal/memory/adapters/index.js", import.meta.url).href;

const NAMES = [
  "azureOpenAiMemoryEmbeddingProviderAdapter",
  "cohereMemoryEmbeddingProviderAdapter",
  "deepinfraMemoryEmbeddingProviderAdapter",
  "geminiMemoryEmbeddingProviderAdapter",
  "jinaMemoryEmbeddingProviderAdapter",
  "mistralMemoryEmbeddingProviderAdapter",
  "ollamaMemoryEmbeddingProviderAdapter",
  "openAiMemoryEmbeddingProviderAdapter",
  "openRouterMemoryEmbeddingProviderAdapter",
  "voyageMemoryEmbeddingProviderAdapter",
] as const;

describe("embedding adapters are single-copy", () => {
  it.each(NAMES)("%s is the same reference in both packages", async (name) => {
    const entry = createRequire(import.meta.url).resolve("../../sdk-memory/package.json");
    const url = pathToFileURL(entry.replace(/package\.json$/, "dist/index.js")).href;
    const peer = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    const shared = (await import(/* @vite-ignore */ sharedUrl)) as Record<string, unknown>;
    expect(shared[name]).toBeDefined();
    expect(peer[name]).toBe(shared[name]);
  });
});
