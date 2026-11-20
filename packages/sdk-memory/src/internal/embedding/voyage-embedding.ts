import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * Voyage AI embedding adapter — `POST /v1/embeddings` at
 * `https://api.voyageai.com` with the OpenAI-compatible `{ model, input }`
 * request shape. Free tier (200M tokens/month) covers most SDK use.
 *
 * Honors `VOYAGE_API_KEY` and `VOYAGE_API_BASE_URL`.
 *
 * Iter 74 (Stage 3 source-move #34): hybrid copy from sdk-core's
 * `internal/memory/adapters/voyage-embedding.ts`.
 *
 * @internal
 */

export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-3-lite";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "voyage-3-lite": 512,
  "voyage-3": 1024,
  "voyage-3-large": 1024,
  "voyage-code-3": 1024,
  "voyage-multilingual-2": 1024,
};

/**
 * Voyage AI embeddings, over the standard OpenAI wire. Default model
 * `voyage-3-lite` at 512 dimensions — the narrowest in the catalog, which makes
 * the index smaller and the search cheaper at some cost in quality; `voyage-3`
 * and `voyage-3-large` are 1024, and `voyage-code-3` is the one to pick for
 * source code.
 *
 * Reads `VOYAGE_API_KEY` and honours `VOYAGE_API_BASE_URL`. Priority 14.
 */
export const voyageMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "voyage",
  defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "voyage",
  autoSelectPriority: 14,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
    createOpenAiCompatibleRuntime(
      {
        id: "voyage",
        defaultBaseUrl: "https://api.voyageai.com",
        apiKeyEnv: "VOYAGE_API_KEY",
        baseUrlEnv: "VOYAGE_API_BASE_URL",
        defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
        dimensionByModel: DIMENSION_BY_MODEL,
      },
      options,
    ),
};
