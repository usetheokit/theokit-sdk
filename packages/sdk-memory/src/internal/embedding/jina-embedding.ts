import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * Jina AI embedding adapter — OpenAI-compatible at `https://api.jina.ai/v1/embeddings`.
 *
 * Honors `JINA_API_KEY`.
 *
 * theokit#128 (catalog parity): mirrors sdk-core's T4.10 adapter, which the peer never picked up.
 *
 * @internal
 */

export const DEFAULT_JINA_EMBEDDING_MODEL = "jina-embeddings-v3";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "jina-embeddings-v3": 1024,
  "jina-embeddings-v2-base-en": 768,
  "jina-embeddings-v2-small-en": 512,
};

/**
 * Jina AI embeddings, over the standard OpenAI wire. Highest auto-select
 * priority in the catalog (35), so it wins over OpenAI when both keys are
 * present.
 *
 * Default `jina-embeddings-v3` at 1024 dimensions; the v2 models are 768 and
 * 512. Reads `JINA_API_KEY`. No base-URL environment override is declared —
 * point it elsewhere by passing `baseUrl` to `create`.
 */
export const jinaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "jina",
  defaultModel: DEFAULT_JINA_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "jina",
  autoSelectPriority: 35,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
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
