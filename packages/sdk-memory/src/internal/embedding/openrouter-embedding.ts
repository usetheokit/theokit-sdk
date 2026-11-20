import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * OpenRouter embedding adapter — routes through OpenRouter's
 * `POST /api/v1/embeddings` endpoint (OpenAI-compatible request/response
 * shape). The provider id strings follow OpenRouter's catalog
 * (e.g. `"openai/text-embedding-3-small"`, `"mistralai/mistral-embed"`).
 *
 * Honors `OPENROUTER_API_KEY` and `OPENROUTER_API_BASE_URL`. Default base
 * URL is `https://openrouter.ai/api`.
 *
 * Iter 74 (Stage 3 source-move #35): hybrid copy from sdk-core's
 * `internal/memory/adapters/openrouter-embedding.ts`.
 *
 * @internal
 */

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "openai/text-embedding-ada-002": 1536,
  "mistralai/mistral-embed": 1024,
};

/**
 * Embeddings routed through OpenRouter, which lets one key reach several
 * upstream providers. Use it when you want to switch provider without changing
 * credentials; use the provider's own adapter when you want its full model
 * range, since only the four ids in this adapter's dimension table are
 * accepted.
 *
 * Model ids carry the upstream prefix, for example
 * `openai/text-embedding-3-small` or `mistralai/mistral-embed`. The endpoint is
 * `/v1/embeddings` under the base `https://openrouter.ai/api`. Reads
 * `OPENROUTER_API_KEY` and honours `OPENROUTER_API_BASE_URL`. Priority 15.
 */
export const openRouterMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openrouter",
  defaultModel: DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "openrouter",
  autoSelectPriority: 15,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
    createOpenAiCompatibleRuntime(
      {
        id: "openrouter",
        defaultBaseUrl: "https://openrouter.ai/api",
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseUrlEnv: "OPENROUTER_API_BASE_URL",
        defaultModel: DEFAULT_OPENROUTER_EMBEDDING_MODEL,
        dimensionByModel: DIMENSION_BY_MODEL,
      },
      options,
    ),
};
