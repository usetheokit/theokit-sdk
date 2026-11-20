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
 * Iter 74 (Stage 3 source-move #36): hybrid copy from sdk-core's
 * `internal/memory/adapters/ollama-embedding.ts`. The only
 * `transport: "local"` adapter in the cluster — enables 100%-local
 * RAG with no remote API key.
 *
 * @internal
 */

import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * Model used when the caller names none: `nomic-embed-text`, 768 dimensions,
 * roughly 274MB to pull. `all-minilm` is the smaller alternative at 384
 * dimensions and roughly 45MB.
 */
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

/**
 * Embeddings from a local Ollama instance — the only adapter in the catalog with
 * `transport: "local"`, and the one to choose when the corpus must not leave the
 * machine or when there is no API key to spend.
 *
 * It needs an Ollama server reachable at `OLLAMA_HOST` (default
 * `http://localhost:11434`) with the chosen embedding model already pulled;
 * nothing here starts a server or downloads a model, so a missing model surfaces
 * as an HTTP error from Ollama rather than a configuration error.
 *
 * No credential is required: a sentinel key is sent and local Ollama ignores it.
 * Set `OLLAMA_API_KEY` for Ollama Cloud or an authenticating reverse proxy.
 *
 * Auto-select priority is 10, the lowest in the catalog, so a configured remote
 * provider wins over it. Request it explicitly to prefer local.
 */
export const ollamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "ollama",
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "local" as const,
  authProviderId: "ollama",
  // Lower than remote providers — chosen only when explicitly requested
  // OR when no remote provider key is configured (local-first developer).
  autoSelectPriority: 10,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) => {
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
