import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

/**
 * Voyage AI embedding adapter — `POST /v1/embeddings` at
 * `https://api.voyageai.com` with the OpenAI-compatible `{ model, input }`
 * request shape. Free tier (200M tokens/month) covers most SDK use.
 *
 * Honors `VOYAGE_API_KEY` and `VOYAGE_API_BASE_URL`.
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

export const voyageMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "voyage",
  defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "voyage",
  autoSelectPriority: 14,
  create: (options) =>
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
