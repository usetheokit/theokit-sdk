/**
 * Ollama embedding adapter (T3.1, ADR D183).
 *
 * Targets Ollama's OpenAI-compatible `/v1/embeddings` endpoint and reuses
 * the shared `createOpenAiCompatibleRuntime` factory. The differentiating
 * bits:
 *
 *  - `authType: "none"` — Ollama local ignores `Authorization`. Sentinel
 *    `"ollama-local"` is passed as apiKey to satisfy the factory contract
 *    (mirrors peer-project `OLLAMA_DEFAULT_API_KEY = "ollama-local"`).
 *  - `OLLAMA_HOST` overrides the default `http://localhost:11434`.
 *  - `OLLAMA_API_KEY` (optional) overrides the sentinel for Ollama Cloud
 *    or reverse-proxy auth setups.
 *  - Default model: `nomic-embed-text` (768 dim, ~274MB). User can opt
 *    into `all-minilm` (384 dim, ~45MB) or any other locally-installed
 *    embedding model.
 *
 * EC-B MUST FIX (edge-case review 2026-05-21): empty text is rejected
 * upstream in the shared factory (`classifyEntry` short-circuits to a
 * zero vector). That behavior is acceptable here because the zero
 * vector is identical for any empty input — downstream similarity
 * calcs ignore zero-norm vectors via the existing `cosineSimilarity`
 * guard. No additional fail-fast needed.
 *
 * EC-A MUST FIX (edge-case review 2026-05-21): dimension is locked
 * by the `DIMENSION_BY_MODEL` table; an unknown model id throws
 * `ConfigurationError(code: "embedding_unknown_model")` per the
 * factory's EC-4 contract. Future model versions with different
 * dimensions are added to the table here without breaking changes.
 *
 * @internal
 */

import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

/** Sentinel forwarded as Bearer token; Ollama local ignores Authorization. */
const OLLAMA_LOCAL_SENTINEL_KEY = "ollama-local";

const DIMENSION_BY_MODEL: Record<string, number> = {
  // Nomic — local default, recommended quality/size balance.
  "nomic-embed-text": 768,
  "nomic-embed-text:latest": 768,
  // Sentence-transformers MiniLM — smaller, faster, lower quality.
  "all-minilm": 384,
  "all-minilm:latest": 384,
  // BGE family.
  "bge-large": 1024,
  "bge-large:latest": 1024,
  "bge-m3": 1024,
  "bge-m3:latest": 1024,
  // mxbai-embed-large.
  "mxbai-embed-large": 1024,
  "mxbai-embed-large:latest": 1024,
};

export const ollamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "ollama",
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "local",
  authProviderId: "ollama",
  // Lower than remote providers — chosen only when explicitly requested
  // OR when no remote provider key is configured (local-first developer).
  autoSelectPriority: 10,
  create: (options) => {
    // Honor OLLAMA_API_KEY (Ollama Cloud / reverse-proxy auth), else use
    // sentinel that local Ollama silently ignores. This mirrors
    // `sentinelForNoAuth` in router.ts and peer-project's `resolveSyntheticAuth`.
    const apiKey = options.apiKey ?? process.env.OLLAMA_API_KEY ?? OLLAMA_LOCAL_SENTINEL_KEY;
    return createOpenAiCompatibleRuntime(
      {
        id: "ollama",
        defaultBaseUrl: "http://localhost:11434",
        apiKeyEnv: "OLLAMA_API_KEY",
        baseUrlEnv: "OLLAMA_HOST",
        defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
        dimensionByModel: DIMENSION_BY_MODEL,
      },
      { ...options, apiKey },
    );
  },
};
