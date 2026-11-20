import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * DeepInfra embedding adapter — hosts open-source embedding models
 * (BGE, E5, Jina, etc.) at pay-per-token. OpenAI-compatible REST at
 * `POST /v1/openai/embeddings` (note the `/openai` segment; not the
 * canonical `/v1/embeddings`). The `embeddingsPath` override on
 * `OpenAiCompatibleConfig` REPLACES the default suffix (EC-2).
 *
 * Honors `DEEPINFRA_API_KEY` and `DEEPINFRA_API_BASE_URL`.
 *
 * Iter 74 (Stage 3 source-move #33): hybrid copy from sdk-core's
 * `internal/memory/adapters/deepinfra-embedding.ts`.
 *
 * @internal
 */

export const DEFAULT_DEEPINFRA_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "BAAI/bge-large-en-v1.5": 1024,
  "BAAI/bge-base-en-v1.5": 768,
  "BAAI/bge-small-en-v1.5": 384,
  "BAAI/bge-m3": 1024,
  "intfloat/e5-large-v2": 1024,
  "intfloat/e5-base-v2": 768,
  "intfloat/multilingual-e5-large": 1024,
  "sentence-transformers/all-MiniLM-L6-v2": 384,
  "thenlper/gte-large": 1024,
  "thenlper/gte-base": 768,
};

/**
 * Open-weight embedding models (BGE, E5, GTE, MiniLM) hosted by DeepInfra.
 * Reach for it when you want a specific open model — particularly a multilingual
 * one — behind a hosted API rather than running it yourself.
 *
 * Its endpoint is `/v1/openai/embeddings`, not the canonical `/v1/embeddings`;
 * the wire format is otherwise OpenAI-shaped. Reads `DEEPINFRA_API_KEY` and
 * honours `DEEPINFRA_API_BASE_URL`. Priority 13.
 *
 * Dimensions vary sharply across the ten models it knows (384 to 1024), and
 * switching between them invalidates an existing vector index — the index drops
 * every vector and re-embeds on the next sync.
 */
export const deepinfraMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "deepinfra",
  defaultModel: DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "deepinfra",
  autoSelectPriority: 13,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
    createOpenAiCompatibleRuntime(
      {
        id: "deepinfra",
        defaultBaseUrl: "https://api.deepinfra.com",
        apiKeyEnv: "DEEPINFRA_API_KEY",
        baseUrlEnv: "DEEPINFRA_API_BASE_URL",
        defaultModel: DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
        dimensionByModel: DIMENSION_BY_MODEL,
        embeddingsPath: "/v1/openai/embeddings",
      },
      options,
    ),
};
