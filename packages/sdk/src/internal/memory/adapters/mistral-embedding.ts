import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

/**
 * Mistral embedding adapter — OpenAI-compatible REST surface
 * (`POST /v1/embeddings` against `https://api.mistral.ai`). Default model
 * `mistral-embed` (1024 dims).
 *
 * Mirrors `reference/peer-project/extensions/mistral/memory-embedding-adapter.ts`.
 *
 * @internal
 */

export const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "mistral-embed": 1024,
};

export const mistralMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "mistral",
  defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "mistral",
  autoSelectPriority: 18,
  create: (options) =>
    createOpenAiCompatibleRuntime(
      {
        id: "mistral",
        defaultBaseUrl: "https://api.mistral.ai",
        apiKeyEnv: "MISTRAL_API_KEY",
        baseUrlEnv: "MISTRAL_API_BASE_URL",
        defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
        dimensionByModel: DIMENSION_BY_MODEL,
      },
      options,
    ),
};
