import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// **Iter 74 rollup-plugin-dts workaround:** importing
// `MemoryEmbeddingProviderAdapter` from sibling `./embedding-adapter.js`
// fails dts emit because no public type reaches it transitively yet
// (same iter 48/53/55/66/67/69/72 class). Fix: drop the explicit
// type annotation on the exported adapter; TS infers the structural
// shape from the literal, and the catalog (iter 37 / this same iter)
// pin assignability against the canonical interface via its own
// `Record<string, MemoryEmbeddingProviderAdapter>` constraint.

/**
 * OpenAI embedding adapter (ADR D3) — built on the shared OpenAI-compatible
 * factory. Native fetch only.
 *
 * Iter 74 (Stage 3 source-move #31): hybrid copy from sdk-core's
 * `internal/memory/adapters/openai-embedding.ts`. Composes iter 45's
 * `MemoryEmbeddingProviderAdapter` + iter 73's
 * `createOpenAiCompatibleRuntime`.
 *
 * @internal
 */

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/**
 * OpenAI embeddings — `text-embedding-3-small` (1536), `text-embedding-3-large` (3072) and
 * `text-embedding-ada-002` (1536).
 *
 * It is NOT selected for you. The provider is whatever the caller names in
 * `embedding: { provider }`; omit that and no embedding runtime is built at all. Its
 * `autoSelectPriority` of `20` is metadata no code path reads today, and it is not the highest
 * value in the catalog either — `jina` is 35, `cohere` and `gemini` are 30, `azure-openai` is 25.
 * The 3072-wide `text-embedding-3-large` is reachable through `azure-openai` and, as
 * `openai/text-embedding-3-large`, through `openrouter` as well.
 *
 * Reads `OPENAI_API_KEY`; `OPENAI_API_BASE_URL` redirects it at a compatible
 * gateway. `create` rejects with an `AuthenticationError`
 * (`embedding_missing_api_key`) when no key is found, and with a
 * `ConfigurationError` (`embedding_unknown_model`) for a model outside
 * `text-embedding-3-small`, `text-embedding-3-large` and
 * `text-embedding-ada-002` — the dimension has to be known before any vector
 * table is created, so an unlisted model is refused rather than probed.
 */
export const openAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openai",
  defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "openai",
  autoSelectPriority: 20,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
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
