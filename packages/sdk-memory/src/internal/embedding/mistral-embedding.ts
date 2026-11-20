import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * Mistral embedding adapter — OpenAI-compatible REST surface
 * (`POST /v1/embeddings` against `https://api.mistral.ai`). Default model
 * `mistral-embed` (1024 dims).
 *
 * Mirrors `reference/peer-project/extensions/mistral/memory-embedding-adapter.ts`.
 *
 * Iter 74 (Stage 3 source-move #32): hybrid copy from sdk-core's
 * `internal/memory/adapters/mistral-embedding.ts`.
 *
 * @internal
 */

export const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "mistral-embed": 1024,
};

/**
 * Mistral embeddings, over the standard OpenAI wire. One model only,
 * `mistral-embed` at 1024 dimensions; any other id is refused with
 * `embedding_unknown_model`.
 *
 * Reads `MISTRAL_API_KEY` and honours `MISTRAL_API_BASE_URL`. Priority 18, just
 * below OpenAI.
 */
export const mistralMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "mistral",
  defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "mistral",
  autoSelectPriority: 18,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
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
