import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * Google Gemini embedding adapter — the OpenAI-compatible surface at
 * `https://generativelanguage.googleapis.com/v1/embeddings`.
 *
 * Gemini's NATIVE embedding endpoint has a different shape
 * (`POST /v1beta/models/{model}:embedContent`); this adapter deliberately targets the
 * OpenAI-compatible one so it composes with the shared runtime.
 *
 * Honors `GEMINI_API_KEY`.
 *
 * theokit#128 (catalog parity): mirrors sdk-core's T4.10 adapter, which the peer never picked up.
 *
 * @internal
 */

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "text-embedding-004";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "text-embedding-004": 768,
  "embedding-001": 768,
};

/**
 * Google Gemini embeddings through Google's OpenAI-compatible surface at
 * `/v1beta/openai/embeddings`. Gemini's native embedding endpoint
 * (`/v1beta/models/{model}:embedContent`) has a different shape and is
 * deliberately not used, so this composes with the shared runtime like the rest.
 *
 * Both known models are 768 dimensions. Reads `GEMINI_API_KEY`; no base-URL
 * environment override is declared. Priority 30.
 */
export const geminiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "gemini",
  defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "gemini",
  autoSelectPriority: 30,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
    createOpenAiCompatibleRuntime(
      {
        id: "gemini",
        defaultBaseUrl: "https://generativelanguage.googleapis.com",
        apiKeyEnv: "GEMINI_API_KEY",
        defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
        // theokit#159 — the compat surface is under `/v1beta/openai/`, not the default
        // `/v1/embeddings`; the previous path 404'd on every call.
        embeddingsPath: "/v1beta/openai/embeddings",
        dimensionByModel: DIMENSION_BY_MODEL,
      },
      options,
    ),
};
