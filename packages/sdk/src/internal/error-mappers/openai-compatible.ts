/**
 * OpenAI-compatible HTTP error mapper (ADR D67).
 *
 * Translates OpenAI-shaped API error responses (covers OpenAI, OpenRouter,
 * DeepSeek, Together, Mistral, Voyage, DeepInfra, etc.) into typed
 * `TheokitAgentError` subclasses with full `ErrorMetadata`.
 *
 * Body inspection: looks at `body.error.code` / `body.error.type` to detect
 * `context_too_long`, `content_filtered`, `model_unavailable` semantics, and at
 * `body.error.message` for a 404 that says no endpoint serves the model
 * (OpenRouter's numeric-code body for a retired model id).
 * Falls back to status-based mapping when body doesn't expose `.error`
 * (e.g., HTML server error page, DeepInfra's `{message: "..."}` shape).
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

interface MapOpenAiErrorArgs {
  providerId: string;
  status: number;
  body: unknown;
  headers: Headers | undefined;
  endpoint: string;
}

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
    const detailed = formatMessage(providerId, status, code, extractOpenAiErrorMessage(body));
    return new ConfigurationError(detailed, {
      code: `${providerId}_model_unavailable`,
      metadata,
    });
  }
  if (status === 400) {
    return new ConfigurationError(message, { code: `${providerId}_${code}`, metadata });
  }
  if (status === 408) {
    return new NetworkError(message, { code: `${providerId}_timeout`, metadata });
  }
  if (status >= 500 && status < 600) {
    return new NetworkError(message, { code: `${providerId}_server_error`, metadata });
  }
  return new UnknownAgentError(message, { code: `${providerId}_unknown`, metadata });
}

function extractOpenAiErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const err = (body as { error?: { code?: unknown; type?: unknown } }).error;
  if (err === undefined || err === null) return undefined;
  if (typeof err.code === "string") return err.code;
  if (typeof err.type === "string") return err.type;
  return undefined;
}

function extractOpenAiErrorMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const err = (body as { error?: { message?: unknown } }).error;
  if (err === undefined || err === null) return undefined;
  return typeof err.message === "string" ? err.message : undefined;
}

// OpenRouter answers a model it does not serve with HTTP 404 and a numeric `error.code`,
// so only the message tells it apart from a 404 for a wrong path (measured 2026-10-20).
const MISSING_MODEL_MESSAGE = /no endpoints found/i;

function mapOpenAiStatusToCode(status: number, body: unknown): ErrorCode {
  const fromBodyCode = classifyOpenAiBodyCode(extractOpenAiErrorCode(body)?.toLowerCase() ?? "");
  if (fromBodyCode !== undefined) return fromBodyCode;
  if (isMissingModel404(status, body)) return "model_unavailable";

  // Everything below the body dialect is RFC 9110 and lives once, in shared.ts.
  return httpStatusToErrorCode(status);
}

function isMissingModel404(status: number, body: unknown): boolean {
  return status === 404 && MISSING_MODEL_MESSAGE.test(extractOpenAiErrorMessage(body) ?? "");
}

function classifyOpenAiBodyCode(rawCode: string): ErrorCode | undefined {
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
  // T3.7 — OpenRouter "Insufficient credits" / `insufficient_quota` in the BODY.
  // The status-402 half of this rule moved to the shared ladder, where it now
  // reaches all four mappers instead of this one; what stays here is the part
  // that is genuinely a body dialect.
  if (rawCode.includes("insufficient_quota") || rawCode.includes("quota_exceeded")) {
    return "quota_exceeded";
  }
  return undefined;
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
