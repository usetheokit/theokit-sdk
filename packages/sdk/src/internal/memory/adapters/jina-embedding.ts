import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

/**
 * T4.10 — Jina AI embedding adapter. Jina's embedding API is
 * OpenAI-compatible at `https://api.jina.ai/v1/embeddings`.
 *
 * @internal
 */

export const DEFAULT_JINA_EMBEDDING_MODEL = "jina-embeddings-v3";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "jina-embeddings-v3": 1024,
  "jina-embeddings-v2-base-en": 768,
  "jina-embeddings-v2-small-en": 512,
};

export const jinaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "jina",
  defaultModel: DEFAULT_JINA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "jina",
  autoSelectPriority: 35,
  create: (options) =>
    createOpenAiCompatibleRuntime(
      {
        id: "jina",
        defaultBaseUrl: "https://api.jina.ai",
        apiKeyEnv: "JINA_API_KEY",
        defaultModel: DEFAULT_JINA_EMBEDDING_MODEL,
        dimensionByModel: DIMENSION_BY_MODEL,
      },
      options,
    ),
};
