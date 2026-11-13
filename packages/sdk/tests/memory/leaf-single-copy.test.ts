/**
 * #1065: the index and store leaf modules have ONE copy. Every function, class and constant that
 * `@theokit/sdk-memory` exports from them is the same reference as the SDK's.
 * `pnpm build` must precede this file (it imports the built peer).
 */
import { describe, expect, it } from "vitest";
// The built SDK, not `src/`: the peer resolves `@theokit/sdk` to `dist`, so that is the copy it shares.
import * as sdk from "../../dist/internal/memory/storage/index.js";

describe("memory leaf modules: one copy shared by sdk and sdk-memory", () => {
  it("re-exports the SDK references", async () => {
    const peer = (await import("../../../sdk-memory/dist/index.js")) as Record<string, unknown>;
    const shared = [
      "ActiveMemoryCache",
      "openMemoryDb",
      "SCHEMA_STATEMENTS",
      "PRAGMA_STATEMENTS",
      "parseSearchOptions",
      "loadSqliteVecExtension",
      "chunkMarkdown",
      "DEFAULT_MEMORY_READ_LINES",
      "readMemoryFileBounded",
      "createVectorIndex",
      "dropVectorIndex",
      "embedMissingChunks",
      "identityMatches",
      "META_KEY_DIMENSION",
      "META_KEY_MODEL",
      "META_KEY_PROVIDER_ID",
      "packVector",
      "readEmbeddingIdentity",
      "upsertEmbedding",
      "vectorSearch",
      "writeEmbeddingIdentity",
    ];
    const own = sdk as Record<string, unknown>;
    for (const name of shared) {
      expect(own[name], name).toBeDefined();
      expect(peer[name], name).toBe(own[name]);
    }
  });
});
