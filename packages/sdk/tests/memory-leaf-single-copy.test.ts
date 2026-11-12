/**
 * #1065: the memory leaf modules have ONE implementation. Each function or class `@theokit/sdk-memory`
 * exports from them must be the same reference as the SDK's. `pnpm build` must precede this file.
 */
import { describe, expect, it } from "vitest";

const SHARED = [
  "ActiveMemoryCache",
  "PRAGMA_STATEMENTS",
  "SCHEMA_STATEMENTS",
  "chunkMarkdown",
  "createVectorIndex",
  "dropVectorIndex",
  "embedMissingChunks",
  "identityMatches",
  "loadSqliteVecExtension",
  "openMemoryDb",
  "packVector",
  "readEmbeddingIdentity",
  "readMemoryFileBounded",
  "upsertEmbedding",
  "vectorSearch",
  "writeEmbeddingIdentity",
] as const;

async function loadSdkStore(): Promise<Record<string, unknown>> {
  // The BUILT subpath the peer resolves, not `src`: the peer imports the dist copy.
  return (await import("../dist/internal/memory/storage/index.js")) as Record<string, unknown>;
}

describe("memory leaf modules are single-copy", () => {
  it.each(SHARED)("%s is the SDK's reference", async (name) => {
    const peer = (await import("../../sdk-memory/dist/index.js")) as unknown as Record<
      string,
      unknown
    >;
    expect(peer[name]).toBeDefined();
    expect(peer[name]).toBe((await loadSdkStore())[name]);
  });
});
