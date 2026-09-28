import {
  AuthenticationError,
  ConfigurationError,
  IntegrationNotConnectedError,
  NetworkError,
  RateLimitError,
  type TheokitAgentError,
  UnknownAgentError,
} from "../errors.js";
import { getConfiguredBaseUrl } from "./base-url.js";
import { boundFetch } from "./runtime-fetch.js";

/**
 * Default base URL used when neither `THEOKIT_API_BASE_URL` nor an explicit
 * override is provided. The fixture-mode short-circuit normally bypasses this
 * for `theo_test_*` keys; consumers with real keys hit this URL.
 *
 * @internal
 */
export const DEFAULT_BASE_URL = "https://api.usetheo.dev";

/**
 * HTTP request options accepted by {@link httpRequest}.
 *
 * @internal
 */
export interface HttpRequestOptions {
  apiKey: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Override the default `fetch` (useful for tests / instrumentation). */
  fetchFn?: typeof globalThis.fetch;
  /** Extra headers merged into the default set. */
  headers?: Record<string, string>;
}

/**
 * Server-side error envelope (`{ error: { code, message, ... } }` or a flat
 * shape) parsed off non-2xx responses.
 *
 * @internal
 */
interface ErrorEnvelope {
  code?: string;
  message?: string;
  protoErrorCode?: string;
  provider?: string;
  helpUrl?: string;
}

/**
 * Resolve the effective base URL (explicit env > default).
 *
 * @internal
 */
export function resolveBaseUrl(): string {
  return getConfiguredBaseUrl() ?? DEFAULT_BASE_URL;
}

/**
 * Perform an authenticated JSON HTTP request, mapping non-2xx responses to
 * the public typed-error hierarchy. Throws subclasses of `TheokitAgentError`
 * on failure.
 *
 * @internal
 */
export async function httpRequest<T>(path: string, options: HttpRequestOptions): Promise<T> {
  const url = `${resolveBaseUrl()}${path}`;
  const fetchFn = boundFetch(options.fetchFn);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
    ...(options.headers ?? {}),
  };
  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;

  const response = await safeFetch(fetchFn, url, {
    method: options.method ?? "GET",
    headers,
    body,
  });

  if (!response.ok) {
    const parsed = await safeParseJsonResponse(response);
    throw mapHttpStatusToError(response.status, parsed);
  }

  return (await safeParseJsonResponse(response)) as T;
}

async function safeFetch(
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (cause) {
    throw new NetworkError("HTTP request failed", { code: "network_error", cause });
  }
}

async function safeParseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Read the body of a NON-OK response for an error mapper: JSON when it parses, the raw
 * text otherwise (never throws, never `undefined` — an unreadable stream reads as `""`).
 *
 * Distinct from {@link safeParseJsonResponse}, which drops a non-JSON body to `undefined`.
 * Error mappers need the raw text preserved: it is what surfaces on the mapped error's
 * `raw` field when a provider answers with HTML or a bare string.
 *
 * @internal
 */
export async function readErrorResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    // not JSON — keep as string for the mapper's raw field
    return text;
  }
}

/**
 * Translate an HTTP error response into a typed `TheokitAgentError` subclass.
 *
 * @internal
 */
export function mapHttpStatusToError(status: number, body: unknown): TheokitAgentError {
  const envelope = extractErrorEnvelope(body);
  const message = envelope.message ?? `HTTP ${status}`;
  const errorOptions = {
    code: envelope.code,
    protoErrorCode: envelope.protoErrorCode,
    cause: body,
  };

  // The envelope is a Theokit-API contract and outranks the status: the server has
  // told us WHICH condition this is, and the status is only its HTTP shadow.
  if (envelope.code === "integration_not_connected") {
    return new IntegrationNotConnectedError(message, {
      provider: envelope.provider ?? "unknown",
      helpUrl: envelope.helpUrl ?? "",
      code: envelope.code,
      cause: body,
    });
  }
  return statusToError(status, message, errorOptions);
}

/**
 * The status ladder, split out from the envelope handling above.
 *
 * Two responsibilities lived in one function and it crossed the cognitive-complexity
 * ceiling the moment the 408 arm was added. They are genuinely different questions —
 * "did the server name the condition?" and "what does this status mean?" — and only
 * the second one grows as statuses are added.
 */
function statusToError(
  status: number,
  message: string,
  errorOptions: { code?: string; protoErrorCode?: string; cause: unknown },
): TheokitAgentError {
  if (status === 401 || status === 403) {
    return new AuthenticationError(message, errorOptions);
  }
  if (status === 429) {
    return new RateLimitError(message, errorOptions);
  }
  if (status === 408) {
    // 408 Request Timeout is TRANSIENT, not a caller mistake: the request did not arrive in time
    // and the same request may succeed on retry. Without this arm 408 fell through to the generic
    // 4xx branch below and came back as a non-retryable ConfigurationError, while all four provider
    // mappers — openai-compatible.ts:59, anthropic.ts:67, bedrock.ts:71, vertex.ts:54 — already map
    // it to a retryable NetworkError with a `timeout` code. This ladder is the fifth copy of that
    // knowledge and it was the copy that drifted.
    return new NetworkError(message, { ...errorOptions, code: errorOptions.code ?? "timeout" });
  }
  if (status >= 400 && status < 500) {
    return new ConfigurationError(message, errorOptions);
  }
  if (status >= 500) {
    return new NetworkError(message, errorOptions);
  }
  return new UnknownAgentError(message, errorOptions);
}

function extractErrorEnvelope(body: unknown): ErrorEnvelope {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const inner = record.error;
  const source: unknown = inner && typeof inner === "object" ? inner : record;
  return readEnvelopeFields(source as Record<string, unknown>);
}

function readEnvelopeFields(record: Record<string, unknown>): ErrorEnvelope {
  return {
    code: pickString(record, "code"),
    message: pickString(record, "message"),
    protoErrorCode: pickString(record, "protoErrorCode"),
    provider: pickString(record, "provider"),
    helpUrl: pickString(record, "helpUrl"),
  };
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
