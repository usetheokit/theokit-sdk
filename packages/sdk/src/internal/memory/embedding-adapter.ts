/**
 * Memory embedding provider adapter contract (ADR D3 of memory-system-peer-project-parity).
 *
 * Mirrors peer-project's `MemoryEmbeddingProviderAdapter` from
 * `reference/peer-project/extensions/openai/memory-embedding-adapter.ts` so
 * adding a new provider becomes one new file under `adapters/`.
 *
 * @internal
 */

export interface MemoryEmbeddingProviderAdapter {
  /** Stable provider id (matches peer-project's id catalog: "openai", "mistral", …). */
  readonly id: string;
  /** Default model the adapter uses unless the caller overrides via `options.model`. */
  readonly defaultModel: string;
  /** Transport kind. Remote = network HTTP; local = in-process / on-device. */
  readonly transport: "local" | "remote";
  /** Auth provider id used to resolve API keys (mirrors peer-project). */
  readonly authProviderId?: string;
  /** Higher priority = auto-select this provider first when multiple are available. */
  readonly autoSelectPriority?: number;
  /** Factory — instantiate a per-agent runtime. */
  create(options: CreateAdapterOptions): Promise<EmbeddingRuntime>;
}

export interface CreateAdapterOptions {
  /** Override the adapter's `defaultModel`. */
  model?: string;
  /** Override the API key (else resolved from env). */
  apiKey?: string;
  /** Override the HTTP base URL (else provider default). */
  baseUrl?: string;
  /** Inject a fetch implementation (tests use this to stub HTTP). */
  fetch?: typeof fetch;
  /** Optional cache instance (else a default LRU is created). */
  cache?: EmbeddingCache;
}

export interface EmbeddingRuntime {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  /** Embed N texts → N vectors of length `dimension`. Handles batching internally. */
  embed(texts: ReadonlyArray<string>): Promise<number[][]>;
  /** Observability — cache hit/miss + call counts. */
  stats(): EmbeddingRuntimeStats;
}

export interface EmbeddingRuntimeStats {
  cacheHits: number;
  cacheMisses: number;
  httpCalls: number;
  retries: number;
}

export interface EmbeddingCache {
  get(key: string): number[] | undefined;
  set(key: string, value: number[]): void;
  /** Total entries currently held. */
  size(): number;
}
