/**
 * OpenAI-compatible HTTP error mapper (ADR D67) — sdk-memory inlined copy.
 *
 * Translates OpenAI-shaped API error responses (covers OpenAI, OpenRouter,
 * DeepSeek, Together, Mistral, Voyage, DeepInfra, etc.) into typed
 * `TheokitAgentError` subclasses with full `ErrorMetadata`.
 *
 * Body inspection: looks at `body.error.code` / `body.error.type` to detect
 * `context_too_long`, `content_filtered`, `model_unavailable` semantics.
 * Falls back to status-based mapping when body doesn't expose `.error`
 * (e.g., HTML server error page, DeepInfra's `{message: "..."}` shape).
 *
 * Never throws — caller is already in an error path.
 *
 * Iter 73 (Stage 3 source-move #30): inlined adaptation of sdk-core's
 * `internal/errors/mappers/openai-compatible.ts` + `shared.ts`. sdk-core's
 * mapper is internal — not part of the public errors surface — so sdk-memory
 * carries its own minimal copy here. Behavior MUST stay byte-equivalent
 * with sdk-core's so consumers consuming hits via either package surface
 * see identical error shape.
 *
 * The 4 helpers (`parseRetryAfter`, `truncateRaw`, `buildErrorMetadata`,
 * `mapOpenAICompatibleError`) are intentionally co-located in this single
 * file so all 8 embedding adapter moves (catalog + 7 providers) share one
 * import target.
 *
 * @internal
 */

import {
  AuthenticationError,
  ConfigurationError,
  type ErrorCode,
  type ErrorMetadata,
  NetworkError,
  RateLimitError,
  type TheokitAgentError,
  UnknownAgentError,
} from "@theokit/sdk/errors";

import { redactSecrets } from "./memory-types.js";

const RAW_MAX_BYTES = 2048;
const PROVIDER_DETAIL_MAX_CHARS = 512;
// OpenRouter answers a model it does not serve with HTTP 404 and a numeric `error.code`,
// so only the message tells it apart from a 404 for a wrong path.
const MISSING_MODEL_MESSAGE = /no endpoints found/i;

/**
 * Parse `retry-after` header in numeric-seconds form. HTTP-date form
 * (RFC 7231) returns `undefined` to avoid NaN propagation downstream.
 */
export function parseRetryAfter(headers: Headers | undefined): number | undefined {
  if (headers === undefined) return undefined;
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  return undefined;
}

/**
 * Truncate raw response body to ~2KB and redact known credential
 * patterns so it can ride inside `ErrorMetadata.raw` without
 * ballooning logs OR leaking tokens. Returns `undefined` for
 * null/undefined input.
 */
export function truncateRaw(body: unknown): unknown {
  if (body === null || body === undefined) return undefined;
  const s = typeof body === "string" ? body : JSON.stringify(body);
  const truncated = s.length <= RAW_MAX_BYTES ? s : `${s.slice(0, RAW_MAX_BYTES)}…`;
  return redactSecrets(truncated);
}

/**
 * Build an `ErrorMetadata` object with all optional fields included
 * conditionally (no `undefined` keys in the output).
 */
export function buildErrorMetadata(args: {
  provider: string;
  endpoint: string;
  code: ErrorCode;
  status: number;
  headers: Headers | undefined;
  body: unknown;
}): ErrorMetadata {
  const retryAfter = parseRetryAfter(args.headers);
  const raw = truncateRaw(args.body);
  return {
    provider: args.provider,
    endpoint: args.endpoint,
    code: args.code,
    statusCode: args.status,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(raw !== undefined ? { raw } : {}),
  };
}

interface MapOpenAiErrorArgs {
  providerId: string;
  status: number;
  body: unknown;
  headers: Headers | undefined;
  endpoint: string;
}

/**
 * Turn a failed OpenAI-shaped HTTP response into the typed error the SDK throws.
 * Builds the error, it does not throw it.
 *
 * The HTTP status picks the class: 401 and 403 give an `AuthenticationError`,
 * 429 a `RateLimitError`, 400 a `ConfigurationError`, 408 and 5xx a
 * `NetworkError`, and anything else an `UnknownAgentError`.
 *
 * The `code` on the metadata is finer than the class and is read from
 * `body.error.code` (or `.type`) first, so a 400 that names a context-window
 * problem carries `context_too_long` rather than `invalid_request`. A body code
 * naming an exhausted quota, and HTTP 402, both map to `quota_exceeded` — note
 * that a 402 keeps that code while still producing an `UnknownAgentError`,
 * because no status branch claims it.
 *
 * The raw body rides along on the metadata, truncated to about 2KB and passed
 * through secret redaction, so it is safe to log.
 */
export function mapOpenAICompatibleError(args: MapOpenAiErrorArgs): TheokitAgentError {
  const { providerId, status, body, headers, endpoint } = args;
  const code = mapOpenAiStatusToCode(status, body);
  const message = formatMessage(providerId, status, code);
  const metadata = buildErrorMetadata({
    provider: providerId,
    endpoint,
    code,
    status,
    headers,
    body,
  });

  if (status === 401 || status === 403) {
    return new AuthenticationError(message, { code: `${providerId}_auth_failed`, metadata });
  }
  if (status === 429) {
    return new RateLimitError(message, { code: `${providerId}_rate_limit`, metadata });
  }
  if (status === 404 && code === "model_unavailable") {
    // The model id lives only in the provider's text, so this case carries it.
    const detailed = formatMessage(providerId, status, code, boundedProviderDetail(body));
    return new ConfigurationError(detailed, {
      code: `${providerId}_model_unavailable`,
      metadata,
    });
  }
  if (status === 400) {
    // A 400 is fixed by changing the request, and only the provider's text says what to change.
    const detailed = formatMessage(providerId, status, code, boundedProviderDetail(body));
    return new ConfigurationError(detailed, { code: `${providerId}_${code}`, metadata });
  }
  if (status === 408) {
    return new NetworkError(message, { code: `${providerId}_timeout`, metadata });
  }
  if (status >= 500 && status < 600) {
    return new NetworkError(message, { code: `${providerId}_server_error`, metadata });
  }
  return new UnknownAgentError(message, { code: `${providerId}_unknown`, metadata });
}

function extractOpenAiErrorMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const err = (body as { error?: { message?: unknown } }).error;
  if (err === undefined || err === null) return undefined;
  return typeof err.message === "string" ? err.message : undefined;
}

// Redaction runs before the cut so a key cut short cannot slip past the credential patterns.
function boundedProviderDetail(body: unknown): string | undefined {
  const raw = extractOpenAiErrorMessage(body);
  if (raw === undefined || raw.trim() === "") return undefined;
  const redacted = redactSecrets(raw);
  return redacted.length <= PROVIDER_DETAIL_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, PROVIDER_DETAIL_MAX_CHARS)}…`;
}

function extractOpenAiErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const err = (body as { error?: { code?: unknown; type?: unknown } }).error;
  if (err === undefined || err === null) return undefined;
  if (typeof err.code === "string") return err.code;
  if (typeof err.type === "string") return err.type;
  return undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit branch table is clearer than splitting
function mapOpenAiStatusToCode(status: number, body: unknown): ErrorCode {
  const rawCode = extractOpenAiErrorCode(body)?.toLowerCase() ?? "";

  if (
    rawCode.includes("context_length") ||
    rawCode.includes("context_window") ||
    rawCode.includes("too_many_tokens") ||
    rawCode.includes("max_tokens")
  ) {
    return "context_too_long";
  }
  if (
    rawCode.includes("content_filter") ||
    rawCode.includes("content_policy") ||
    rawCode.includes("safety")
  ) {
    return "content_filtered";
  }
  if (
    rawCode.includes("model_not_found") ||
    rawCode.includes("model_unavailable") ||
    rawCode.includes("invalid_model")
  ) {
    return "model_unavailable";
  }
  // T3.7 — 402 / Insufficient credits / insufficient_quota body code flow
  // to canonical `quota_exceeded` (ADR-spec'd in ErrorCode union).
  if (
    status === 402 ||
    rawCode.includes("insufficient_quota") ||
    rawCode.includes("quota_exceeded")
  ) {
    return "quota_exceeded";
  }

  if (
    status === 404 &&
    MISSING_MODEL_MESSAGE.test(extractOpenAiErrorMessage(body) ?? "")
  ) {
    return "model_unavailable";
  }

  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status === 400) return "invalid_request";
  if (status >= 500 && status < 600) return "server_error";
  return "unknown";
}

function formatMessage(
  providerId: string,
  status: number,
  code: ErrorCode,
  detail?: string,
): string {
  const base = `${providerId} API error: ${code} (HTTP ${status})`;
  return detail === undefined || detail === "" ? base : `${base}: ${detail}`;
}
