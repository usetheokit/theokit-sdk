import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

/**
 * OpenAI embedding adapter (ADR D3) — built on the shared OpenAI-compatible
 * factory. Native fetch only.
 *
 * @internal
 */

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Vector width per OpenAI embedding model.
 *
 * Exported because Azure OpenAI HOSTS these same models, so the Azure adapter was carrying a
 * byte-identical copy — and this table is a correctness gate, not a hint:
 * `createOpenAiCompatibleRuntime` throws `embedding_unknown_model` for anything absent, and a wrong
 * number produces a vec0 dimension mismatch that surfaces much later. Two copies meant adding the
 * next model to one file silently broke the other provider.
 */
export const OPENAI_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

const DIMENSION_BY_MODEL: Record<string, number> = { ...OPENAI_EMBEDDING_DIMENSIONS };

export const openAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openai",
  defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "openai",
  autoSelectPriority: 20,
  create: (options) =>
    createOpenAiCompatibleRuntime(
      {
        id: "openai",
        defaultBaseUrl: "https://api.openai.com",
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrlEnv: "OPENAI_API_BASE_URL",
        defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
        dimensionByModel: DIMENSION_BY_MODEL,
      },
      options,
    ),
};
