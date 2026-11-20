import { azureOpenAiMemoryEmbeddingProviderAdapter } from "./embedding/azure-openai-embedding.js";
import { cohereMemoryEmbeddingProviderAdapter } from "./embedding/cohere-embedding.js";
import { deepinfraMemoryEmbeddingProviderAdapter } from "./embedding/deepinfra-embedding.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./embedding/gemini-embedding.js";
import { jinaMemoryEmbeddingProviderAdapter } from "./embedding/jina-embedding.js";
import { mistralMemoryEmbeddingProviderAdapter } from "./embedding/mistral-embedding.js";
import { ollamaMemoryEmbeddingProviderAdapter } from "./embedding/ollama-embedding.js";
import { openAiMemoryEmbeddingProviderAdapter } from "./embedding/openai-embedding.js";
import { openRouterMemoryEmbeddingProviderAdapter } from "./embedding/openrouter-embedding.js";
import { voyageMemoryEmbeddingProviderAdapter } from "./embedding/voyage-embedding.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.
// Catalog value type is inferred from the literal record; canonical
// assignability is checked at consumer call sites that destructure into
// the canonical `MemoryEmbeddingProviderAdapter` shape.

/**
 * Memory embedding adapter catalog, indexed by provider id.
 *
 * Only adapters with full, tested implementations are exposed. The
 * `openrouter` provider proxies through OpenRouter to whichever embedding
 * model the caller selects via `model` (e.g.
 * `"openai/text-embedding-3-small"`, `"mistralai/mistral-embed"`).
 *
 * Locked by ADR D11: `openai`, `mistral`, `openrouter`, `voyage`, `deepinfra`
 * ship in v1.0. ADR D183: `ollama` added — first `transport: "local"`
 * adapter, enables 100%-local RAG (no remote API key needed).
 * `lmstudio`, `google`, `bedrock` are deferred to v1.1.
 *
 * Iter 74 (Stage 3 source-move #37): hybrid copy from sdk-core's
 * `internal/memory/adapters/catalog.ts`. Filename renamed to
 * `adapter-catalog.ts` in sdk-memory to disambiguate from the broader
 * "catalog" notion at the package barrel level.
 *
 * **This catalog must serve every provider sdk-core ADVERTISES** (theokit#128). When the peer is
 * installed it REPLACES core's catalog in the routing path (`sdk/src/memory.ts`), while the public
 * `Theokit.inspect.embeddingAdapters()` keeps listing core's — so any id core has and this one
 * lacks is a provider the SDK promises and then rejects. That is what happened to `azure-openai`,
 * `cohere`, `jina` and `gemini` for the two months between core's T4.10 and the parity fix.
 * The invariant is enforced by `@theokit/sdk-peer-integration-tests` (`peer-parity.test.ts`).
 *
 * **CLOSES the embedding-adapter cluster in sdk-memory.** The provider adapters + the shared
 * OpenAI-compatible runtime + the inlined HTTP error mapper are canonical here:
 * - iter 45: embedding-adapter (types)
 * - iter 46: embedding-cache (LRU) — REMOVED by theokit#160: the shared runtime owns caching now
 * - iter 73: openai-compatible (shared factory) + adapter-http-error
 *   (inlined mapper)
 * - iter 74: openai-embedding + mistral-embedding + deepinfra-embedding
 *   + voyage-embedding + openrouter-embedding + ollama-embedding +
 *   adapter-catalog (THIS)
 * - theokit#128: azure-openai + cohere + jina + gemini (parity with core's T4.10)
 *
 * @internal
 */
export const MEMORY_EMBEDDING_ADAPTERS = {
  openai: openAiMemoryEmbeddingProviderAdapter,
  mistral: mistralMemoryEmbeddingProviderAdapter,
  openrouter: openRouterMemoryEmbeddingProviderAdapter,
  voyage: voyageMemoryEmbeddingProviderAdapter,
  deepinfra: deepinfraMemoryEmbeddingProviderAdapter,
  ollama: ollamaMemoryEmbeddingProviderAdapter,
  // theokit#128 — mirrors sdk-core's T4.10 additions, which the peer had drifted behind.
  "azure-openai": azureOpenAiMemoryEmbeddingProviderAdapter,
  cohere: cohereMemoryEmbeddingProviderAdapter,
  jina: jinaMemoryEmbeddingProviderAdapter,
  gemini: geminiMemoryEmbeddingProviderAdapter,
};
