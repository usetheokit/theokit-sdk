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
 * (OpenRouter's numeric-code body for a retired model id). A 400 and that 404
 * end their message with the provider's text, redacted and capped at 512
 * characters; every other status keeps the bare message.
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
import { redactSecrets } from "../security/index.js";
import { buildErrorMetadata, httpStatusToErrorCode } from "./shared.js";

// A provider's text joins a message consumers log and show, so it is bounded first. 512 keeps every
// measured text whole (OpenRouter's 400s run 40 to 60 characters, OpenAI's context-length text
// about 250); `metadata.raw` keeps up to 2048 bytes of the body for the rest.
const PROVIDER_DETAIL_MAX_CHARS = 512;

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

// Redaction runs before the cut: a key cut first could keep too few characters to match a
// credential pattern, and its prefix would reach the message unmasked.
function boundedProviderDetail(body: unknown): string | undefined {
  const raw = extractOpenAiErrorMessage(body);
  if (raw === undefined || raw.trim() === "") return undefined;
  const redacted = redactSecrets(raw);
  return redacted.length <= PROVIDER_DETAIL_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, PROVIDER_DETAIL_MAX_CHARS)}…`;
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

// The body dialect, in precedence order: the first rule whose fragment appears in the
// lowercased body code wins.
const BODY_CODE_RULES: ReadonlyArray<{ fragments: readonly string[]; code: ErrorCode }> = [
  {
    fragments: ["context_length", "context_window", "too_many_tokens", "max_tokens"],
    code: "context_too_long",
  },
  { fragments: ["content_filter", "content_policy", "safety"], code: "content_filtered" },
  {
    fragments: ["model_not_found", "model_unavailable", "invalid_model"],
    code: "model_unavailable",
  },
  // T3.7 — OpenRouter "Insufficient credits" / `insufficient_quota` in the BODY.
  // The status-402 half of this rule moved to the shared ladder, where it now
  // reaches all four mappers instead of this one; what stays here is the part
  // that is genuinely a body dialect.
  { fragments: ["insufficient_quota", "quota_exceeded"], code: "quota_exceeded" },
];

function classifyOpenAiBodyCode(rawCode: string): ErrorCode | undefined {
  const rule = BODY_CODE_RULES.find(({ fragments }) =>
    fragments.some((fragment) => rawCode.includes(fragment)),
  );
  return rule?.code;
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
