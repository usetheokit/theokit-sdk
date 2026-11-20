import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

/**
 * T4.10 — Google Gemini embedding adapter. Uses the Gemini API's
 * OpenAI-compatible endpoint at `https://generativelanguage.googleapis.com`.
 *
 * Note: Gemini's native embedding endpoint uses a different shape
 * (`POST /v1beta/models/{model}:embedContent`), but the OpenAI-compat
 * surface (`/v1/embeddings`) is available for embedding models.
 *
 * @internal
 */

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "text-embedding-004";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "text-embedding-004": 768,
  "embedding-001": 768,
};

export const geminiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "gemini",
  defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "gemini",
  autoSelectPriority: 30,
  create: (options) =>
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
