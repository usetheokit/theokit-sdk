/**
 * Anthropic HTTP error mapper (ADR D67).
 *
 * Translates an Anthropic API error response into a typed
 * `TheokitAgentError` subclass with full `ErrorMetadata`. Mapping rules:
 *
 *   401/403 → `AuthenticationError`  (`code: "auth_failed"`)
 *   429     → `RateLimitError`        (`code: "rate_limit"`)
 *   400     → `ConfigurationError`    (`code: "context_too_long"` if body
 *                                       mentions context length, else
 *                                       `"invalid_request"`; or
 *                                       `"content_filtered"` for policy.)
 *   404     → `ConfigurationError`    (`code: "model_unavailable"` when the
 *                                       body is a `not_found_error` naming a
 *                                       model; other 404s stay `unknown`.)
 *   408     → `NetworkError`          (`code: "timeout"`)
 *   5xx     → `NetworkError`          (`code: "server_error"` — covers 529
 *                                       overloaded_error common at peak
 *                                       at peak)
 *   other   → `UnknownAgentError`     (`code: "unknown"`)
 *
 * Never throws — caller is already in an error path.
 *
 * @internal
 */

import {
  AuthenticationError,
  ConfigurationError,
  type ErrorCode,
  NetworkError,
  RateLimitError,
  type TheokitAgentError,
  UnknownAgentError,
} from "../../errors.js";
import { buildErrorMetadata, httpStatusToErrorCode } from "./shared.js";

interface MapAnthropicErrorArgs {
  status: number;
  body: unknown;
  headers: Headers | undefined;
  endpoint: string;
}

export function mapAnthropicError(args: MapAnthropicErrorArgs): TheokitAgentError {
  const { status, body, headers, endpoint } = args;
  const code = mapAnthropicStatusToCode(status, body);
  const message = formatMessage(status, code);
  const metadata = buildErrorMetadata({
    provider: "anthropic",
    endpoint,
    code,
    status,
    headers,
    body,
  });

  if (status === 401 || status === 403) {
    return new AuthenticationError(message, { code: "anthropic_auth_failed", metadata });
  }
  if (status === 429) {
    return new RateLimitError(message, { code: "anthropic_rate_limit", metadata });
  }
  if (status === 400 || code === "model_unavailable") {
    return new ConfigurationError(message, {
      code: `anthropic_${code}`,
      metadata,
    });
  }
  if (status === 408) {
    return new NetworkError(message, { code: "anthropic_timeout", metadata });
  }
  if (status >= 500 && status < 600) {
    return new NetworkError(message, { code: "anthropic_server_error", metadata });
  }
  return new UnknownAgentError(message, { code: "anthropic_unknown", metadata });
}

/**
 * Anthropic's own body dialect first, then the shared RFC 9110 ladder.
 *
 * Only the 400 arm is Anthropic-specific: the vendor expresses "context too long"
 * and "content filtered" inside the body of a generic bad-request, so reading it
 * is a real per-vendor contract. Everything else — 401/403, 402, 408, 429, 5xx —
 * is HTTP semantics and lives once, in `httpStatusToErrorCode`. It used to be
 * copied here, and the copy could not reach `quota_exceeded` at all.
 */
function mapAnthropicStatusToCode(status: number, body: unknown): ErrorCode {
  if (status === 400) return classify400(body);
  if (status === 404 && isModelNotFound(body)) return "model_unavailable";
  return httpStatusToErrorCode(status);
}

function classify400(body: unknown): ErrorCode {
  const text = JSON.stringify(body ?? "").toLowerCase();
  if (
    text.includes("context") &&
    (text.includes("too long") || text.includes("too_long") || text.includes("length"))
  ) {
    return "context_too_long";
  }
  if (
    text.includes("filtered") ||
    text.includes("content policy") ||
    text.includes("content_policy")
  ) {
    return "content_filtered";
  }
  return "invalid_request";
}

// Anthropic answers an unknown model with 404 `not_found_error` and message `model: <id>`.
function isModelNotFound(body: unknown): boolean {
  const error = (body as { error?: { type?: unknown; message?: unknown } } | null)?.error;
  return (
    error?.type === "not_found_error" &&
    typeof error.message === "string" &&
    /^model\b/i.test(error.message)
  );
}

function formatMessage(status: number, code: ErrorCode): string {
  return `Anthropic API error: ${code} (HTTP ${status})`;
}
