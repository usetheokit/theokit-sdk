import { createHash } from "node:crypto";

import { AuthenticationError, ConfigurationError, NetworkError } from "../../../errors.js";
import { mapWithConcurrency } from "../../concurrency/map-with-concurrency.js";
import { mapOpenAICompatibleError } from "../../error-mappers/openai-compatible.js";
import { parseRetryAfter } from "../../error-mappers/shared.js";
import { computeBackoffMs } from "../../llm/retry.js";
import { boundFetch } from "../../runtime-fetch.js";
import type {
  CreateAdapterOptions,
  EmbeddingRuntime,
  EmbeddingRuntimeStats,
} from "../embedding-adapter.js";
import { globalEmbeddingCache } from "../embedding-cache.js";

/**
 * Shared factory for OpenAI-compatible embedding providers (OpenAI, Mistral,
 * DeepInfra, and anything else exposing `POST /v1/embeddings` with the
 * `{ model, input }` request shape and `{ data: [{ embedding }] }` response).
 *
 * Mirrors the inner mechanics of peer-project's batch embedding runtime.
 *
 * @internal
 */

const MAX_BATCH = 100;
const MAX_RETRIES = 2;
/**
 * Deliberately tighter than the transport's 500ms/32s.
 *
 * An embedding retry sits inside a memory write on the agent's critical path and cannot be
 * cancelled (see `sleep` below), so the worst case has to be small enough to wait out: 2 retries
 * capped at 4s is at most ~8s. The transport can afford 32s because a streaming turn is already
 * long-running and IS abortable.
 */
const EMBED_BACKOFF_BASE_MS = 250;
const EMBED_BACKOFF_CAP_MS = 4_000;

/**
 * What one provider adapter tells {@link createOpenAiCompatibleRuntime} about
 * its wire: where to POST, which environment variables carry the key and the
 * base URL, which model to use by default, and how wide each model's vectors
 * are.
 *
 * `id` is the provider id that ends up on errors and on
 * `EmbeddingRuntime.id`, and is also the identity the SQLite vector index stores
 * — changing it invalidates the vectors already on disk.
 *
 * `apiKeyEnv` is required, `baseUrlEnv` is not: a provider that declares no
 * base-URL variable can only be redirected by passing `baseUrl` explicitly.
 * Leave `dialect` unset for anything that speaks the OpenAI embedding wire.
 */
export interface OpenAiCompatibleConfig {
  id: string;
  defaultBaseUrl: string;
  apiKeyEnv: string;
  baseUrlEnv?: string;
  defaultModel: string;
  /**
   * Dimension hint by model id. The chosen model MUST be in this table —
   * unknown models throw `ConfigurationError(code: "embedding_unknown_model")`
   * (EC-4 fix). This prevents vec0 virtual-table dimension mismatches that
   * surface as cryptic errors downstream.
   */
  dimensionByModel: Record<string, number>;
  /**
   * Path component appended to `baseUrl` for the embeddings endpoint.
   * Default `"/v1/embeddings"` (OpenAI canonical). REPLACES the default —
   * does NOT concatenate. Used by DeepInfra (`"/v1/openai/embeddings"`),
   * etc. (EC-2 fix).
   */
  embeddingsPath?: string;
  /**
   * theokit#159 — per-provider deviations from the OpenAI wire.
   *
   * The runtime was rigidly OpenAI-shaped: one auth header, one body, one response shape. Three of
   * the ten catalog providers do not speak it, so every call they made was rejected — Azure
   * authenticates with an `api-key` header and puts the deployment in the path, Cohere's `/v2/embed`
   * takes `texts` and answers `{embeddings:{float}}`. Advertising a provider that cannot work is
   * worse than not advertising it.
   *
   * Every hook is optional and its default is exactly the previous behaviour, so the seven
   * providers that DO speak OpenAI are untouched.
   */
  dialect?: EmbeddingDialect;
}

/**
 * theokit#159 — the three points where a provider may deviate from the OpenAI embedding wire.
 *
 * Deliberately three narrow hooks rather than a general "transform the request" seam: these are the
 * only axes on which the supported providers actually differ, and a wider seam would invite
 * per-provider logic that belongs in the adapter.
 */
export interface EmbeddingDialect {
  /** Replaces `authorization: Bearer <key>`. */
  authHeaders?: (apiKey: string) => Record<string, string>;
  /** Replaces the `{ model, input }` request body. */
  body?: (model: string, inputs: ReadonlyArray<string>) => Record<string, unknown>;
  /** Replaces reading vectors from `json.data[].embedding`. Return `undefined` when unparseable. */
  vectors?: (json: unknown) => number[][] | undefined;
}

/**
 * Build an {@link EmbeddingRuntime} for a provider that speaks the OpenAI
 * embedding wire — or, through `cfg.dialect`, one that deviates from it in a
 * known way. Every adapter in the memory catalog is a thin call to this.
 *
 * Resolution order for each setting is explicit option, then environment
 * variable, then the config default. Two things are checked before any request
 * is sent, so a misconfiguration fails at creation rather than at first search:
 * a missing or empty key rejects with an `AuthenticationError` carrying
 * `embedding_missing_api_key`, and a model absent from `dimensionByModel`
 * rejects with a `ConfigurationError` carrying `embedding_unknown_model`. The
 * second check exists because the vector index is created at a fixed width — an
 * unknown dimension would surface much later as a vec0 mismatch.
 *
 * `{model}` in `embeddingsPath` is replaced with the URL-encoded model, which is
 * how Azure addresses a deployment in the path. `embeddingsPath` replaces the
 * default `/v1/embeddings` rather than being appended to it.
 *
 * The returned `embed` batches at 100 texts per request and runs at most 3
 * requests concurrently, preserving input order. Whitespace-only inputs never
 * reach the network and come back as an all-zero vector. Results are cached by
 * model and text; the cache defaults to a process-wide LRU of 5000 entries, so
 * pass `options.cache` when runtimes must not share entries.
 *
 * Failed requests retry up to twice on 429 and 5xx with a 50ms-per-attempt
 * linear backoff. Anything else, and a retry budget that runs out, throws the
 * typed error the OpenAI-compatible mapper builds from the status and body. A
 * response that parses but carries no vectors throws a `NetworkError` with
 * `embedding_invalid_response`. There is no request timeout here — cancellation
 * is the caller's to impose.
 */
export async function createOpenAiCompatibleRuntime(
  cfg: OpenAiCompatibleConfig,
  options: CreateAdapterOptions,
): Promise<EmbeddingRuntime> {
  const model = options.model ?? cfg.defaultModel;
  const apiKey = options.apiKey ?? process.env[cfg.apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new AuthenticationError(`${cfg.apiKeyEnv} missing`, {
      code: "embedding_missing_api_key",
    });
  }
  const envBaseUrl = cfg.baseUrlEnv !== undefined ? process.env[cfg.baseUrlEnv] : undefined;
  const baseUrl = options.baseUrl ?? envBaseUrl ?? cfg.defaultBaseUrl;
  const fetchImpl = boundFetch(options.fetch);
  // T4.4 — default to process-wide singleton (was per-adapter instance).
  const cache = options.cache ?? globalEmbeddingCache;
  // EC-4: refuse unknown models to prevent vec0 dimension mismatches downstream.
  const dimension = cfg.dimensionByModel[model];
  if (dimension === undefined) {
    throw new ConfigurationError(
      `${cfg.id} adapter: model "${model}" is not in the dimension table. Use one of: ${Object.keys(cfg.dimensionByModel).join(", ")}. To add it, update dimensionByModel in the adapter source.`,
      { code: "embedding_unknown_model" },
    );
  }
  // theokit#128: `{model}` is substituted, because Azure OpenAI addresses the deployment IN THE
  // PATH (`/openai/deployments/{model}/embeddings`) rather than in the body. Without this the URL
  // carried the literal placeholder and every Azure request 404'd. A path with no placeholder —
  // every other provider — is passed through untouched.
  const embeddingsPath = (cfg.embeddingsPath ?? "/v1/embeddings").replace(
    "{model}",
    encodeURIComponent(model),
  );

  const stats: EmbeddingRuntimeStats = {
    cacheHits: 0,
    cacheMisses: 0,
    httpCalls: 0,
    retries: 0,
  };

  return {
    id: cfg.id,
    model,
    dimension,
    stats: () => ({ ...stats }),
    embed: (texts) =>
      embedTexts({
        texts,
        cache,
        stats,
        model,
        dimension,
        apiKey,
        baseUrl,
        embeddingsPath,
        fetchImpl,
        providerId: cfg.id,
        dialect: cfg.dialect ?? {},
      }),
  };
}

interface EmbedTextsInput {
  texts: ReadonlyArray<string>;
  cache: NonNullable<CreateAdapterOptions["cache"]>;
  stats: EmbeddingRuntimeStats;
  model: string;
  dimension: number;
  apiKey: string;
  baseUrl: string;
  embeddingsPath: string;
  fetchImpl: typeof fetch;
  providerId: string;
  dialect: EmbeddingDialect;
}

async function embedTexts(input: EmbedTextsInput): Promise<number[][]> {
  const { texts, cache, stats, model, dimension } = input;
  const results = new Array<number[] | undefined>(texts.length);
  const pending: Array<{ index: number; text: string; key: string }> = [];
  for (let i = 0; i < texts.length; i++) {
    classifyEntry({
      index: i,
      text: texts[i] ?? "",
      model,
      dimension,
      cache,
      stats,
      results,
      pending,
    });
  }
  await embedInBoundedBatches(input, pending, results);
  return results.map((v) => v ?? new Array(dimension).fill(0));
}

interface ClassifyEntryArgs {
  index: number;
  text: string;
  model: string;
  dimension: number;
  cache: NonNullable<CreateAdapterOptions["cache"]>;
  stats: EmbeddingRuntimeStats;
  results: Array<number[] | undefined>;
  pending: Array<{ index: number; text: string; key: string }>;
}

function classifyEntry(args: ClassifyEntryArgs): void {
  if (args.text.trim().length === 0) {
    args.results[args.index] = new Array(args.dimension).fill(0);
    return;
  }
  const key = hashKey(args.model, args.text);
  const cached = args.cache.get(key);
  if (cached !== undefined) {
    args.stats.cacheHits += 1;
    args.results[args.index] = cached;
    return;
  }
  args.stats.cacheMisses += 1;
  args.pending.push({ index: args.index, text: args.text, key });
}

// T4.3 — max concurrent embedding API requests per embed() call.
// 3 is enough to saturate most embedding APIs without triggering
// rate limits (each batch is already up to MAX_BATCH=100 texts).
const MAX_CONCURRENT_BATCHES = 3;

/**
 * T4.3 — parallel embed batches (DR4 finding #3).
 *
 * Pre-T4.3 this was a serial `for` loop — each batch of 100 texts
 * awaited before the next HTTP request started. With 500 texts the
 * serial path took 5 × RTT; parallel takes max(RTT) × ceil(5/3).
 *
 * Uses bounded-concurrency `Promise.all` capped at 3 concurrent
 * HTTP requests to avoid overwhelming the embedding API.
 */
async function embedInBoundedBatches(
  input: EmbedTextsInput,
  pending: ReadonlyArray<{ index: number; text: string; key: string }>,
  results: Array<number[] | undefined>,
): Promise<void> {
  const batches: Array<ReadonlyArray<{ index: number; text: string; key: string }>> = [];
  for (let offset = 0; offset < pending.length; offset += MAX_BATCH) {
    batches.push(pending.slice(offset, offset + MAX_BATCH));
  }
  // M0-2: bounded parallel via the shared ordered pool (was an inline
  // acquire/release clone — see plan m0-foundation-expose-primitives).
  await mapWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch) =>
    processBatch(input, batch, results),
  );
}

async function processBatch(
  input: EmbedTextsInput,
  batch: ReadonlyArray<{ index: number; text: string; key: string }>,
  results: Array<number[] | undefined>,
): Promise<void> {
  const vectors = await embedBatch({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    embeddingsPath: input.embeddingsPath,
    model: input.model,
    inputs: batch.map((b) => b.text),
    fetchImpl: input.fetchImpl,
    stats: input.stats,
    providerId: input.providerId,
    dialect: input.dialect,
  });
  for (let j = 0; j < batch.length; j++) {
    const slot = batch[j];
    const vector = vectors[j];
    if (slot === undefined || vector === undefined) continue;
    results[slot.index] = vector;
    input.cache.set(slot.key, vector);
  }
}

interface BatchOptions {
  apiKey: string;
  baseUrl: string;
  embeddingsPath: string;
  model: string;
  inputs: ReadonlyArray<string>;
  fetchImpl: typeof fetch;
  stats: EmbeddingRuntimeStats;
  providerId: string;
  dialect: EmbeddingDialect;
}

async function embedBatch(opts: BatchOptions): Promise<number[][]> {
  // EC-2: embeddingsPath REPLACES the suffix; never concatenates.
  const url = `${opts.baseUrl.replace(/\/$/, "")}${opts.embeddingsPath}`;
  let attempt = 0;
  while (true) {
    opts.stats.httpCalls += 1;
    const response = await postEmbedRequest(opts, url);
    if (response.ok)
      return await parseEmbedResponse(response, opts.providerId, opts.embeddingsPath, opts.dialect);
    if (isRetryable(response.status) && attempt < MAX_RETRIES) {
      attempt += 1;
      opts.stats.retries += 1;
      const retryAfterSec = parseRetryAfter(response.headers);
      await sleep(
        computeBackoffMs({
          attempt,
          baseMs: EMBED_BACKOFF_BASE_MS,
          capMs: EMBED_BACKOFF_CAP_MS,
          ...(retryAfterSec !== undefined ? { retryAfterMs: retryAfterSec * 1000 } : {}),
        }),
      );
      continue;
    }
    throw await mappedEmbedError(opts, response);
  }
}

/**
 * The terminal failure: read the body best-effort so the mapper sees the provider's error code, then
 * map it. Its own function because folding it back into the retry loop puts `embedBatch` at
 * cognitive complexity 11 against the repo max of 10 — and the sibling budget for those suppressions
 * is ratcheting DOWN, so adding one here to keep this loop whole would undo that.
 */
async function mappedEmbedError(opts: BatchOptions, response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON — keep as string
  }
  return mapOpenAICompatibleError({
    providerId: opts.providerId,
    status: response.status,
    body,
    headers: response.headers,
    endpoint: opts.embeddingsPath,
  });
}

async function postEmbedRequest(opts: BatchOptions, url: string): Promise<Response> {
  return opts.fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.dialect.authHeaders?.(opts.apiKey) ?? { authorization: `Bearer ${opts.apiKey}` }),
    },
    body: JSON.stringify(
      opts.dialect.body?.(opts.model, opts.inputs) ?? { model: opts.model, input: opts.inputs },
    ),
  });
}

async function parseEmbedResponse(
  response: Response,
  providerId: string,
  endpoint: string,
  dialect?: EmbeddingDialect,
): Promise<number[][]> {
  const json = (await response.json()) as { data?: Array<{ embedding: number[] }> };
  // theokit#159 — a provider whose response is not OpenAI-shaped supplies its own reader.
  const viaDialect = dialect?.vectors?.(json);
  if (viaDialect !== undefined) return viaDialect;
  if (!Array.isArray(json.data)) {
    throw new NetworkError(`${providerId} ${endpoint} returned no data`, {
      code: "embedding_invalid_response",
      metadata: {
        provider: providerId,
        endpoint,
        code: "invalid_request",
        raw: json,
      },
    });
  }
  return json.data.map((d) => d.embedding);
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function hashKey(model: string, text: string): string {
  return createHash("sha256").update(`${model} ${text}`).digest("hex");
}

/**
 * Not `sleepWithAbort`, and the reason is the parsimony ladder rather than an oversight.
 *
 * `EmbeddingRuntime.embed(texts)` takes no signal, and NONE of its seven callers — lance-index,
 * index-manager, vec-index, the two dreaming phases, scorers — holds one to pass. Adding the
 * parameter would add a seam nobody supplies, so cancellation is bounded instead of plumbed: at most
 * MAX_RETRIES sleeps of at most EMBED_BACKOFF_CAP_MS each. Give `embed()` a signal on the day a
 * caller has one, and this becomes `sleepWithAbort` in the same edit.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
