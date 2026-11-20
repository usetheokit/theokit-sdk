import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

/**
 * OpenRouter embedding adapter — routes through OpenRouter's
 * `POST /api/v1/embeddings` endpoint (OpenAI-compatible request/response
 * shape). The provider id strings follow OpenRouter's catalog
 * (e.g. `"openai/text-embedding-3-small"`, `"mistralai/mistral-embed"`).
 *
 * Honors `OPENROUTER_API_KEY` and `OPENROUTER_API_BASE_URL`. Default base
 * URL is `https://openrouter.ai/api`.
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

export const openRouterMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openrouter",
  defaultModel: DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "openrouter",
  autoSelectPriority: 15,
  create: (options) =>
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
