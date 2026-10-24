/**
import type { ErrorCode } from "../../errors.js";
 * Helpers shared between provider HTTP error mappers (ADR D67).
 *
 * Extracted to dedupe identical logic in `anthropic.ts` and
 * `openai-compatible.ts` — retry-after parsing, raw-body truncation,
 * and metadata assembly are dialect-agnostic.
 *
 * @internal
 */

import type { ErrorCode, ErrorMetadata } from "../../errors.js";
import { redactSecrets } from "../security/index.js";

/** Longest `ErrorMetadata.raw`, in UTF-16 code units, before the `…` suffix. */
const RAW_MAX_CHARS = 2048;
/** Most of a provider error body passed to redaction, so its cost has a bound whatever the body. */
const REDACT_INPUT_CAP = 65_536;
/**
 * Redacted text dropped before a capped body's end. The cap can cut a credential short of what
 * its pattern needs, leaving a clear fragment at the end of the redacted text; the margin is
 * longer than any credential shape the maskers know, an 8192-bit RSA key block included.
 */
const CAP_EDGE_MARGIN = 16_384;

/**
 * Parse the `Retry-After` header (RFC 7231) into seconds. Both forms are
 * supported: numeric-seconds (`Retry-After: 30`) and HTTP-date
 * (`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT` → seconds until that instant,
 * clamped at 0 for a past date). Garbage / missing header → `undefined`.
 *
 * @internal
 */
export function parseRetryAfter(headers: Headers | undefined): number | undefined {
  if (headers === undefined) return undefined;
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  // HTTP-date form — seconds until the given instant (0 if already elapsed).
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  return undefined;
}

/**
 * Redact known credential patterns in the raw response body, then
 * cut the redacted text to 2048 characters (UTF-16 code units), so it can ride inside
 * `ErrorMetadata.raw` without ballooning logs OR leaking tokens.
 * Returns `undefined` for null/undefined input.
 *
 * Redaction runs first: a pattern can only mask a credential it sees
 * whole, and cutting first left a key straddling the cut too short for
 * its pattern, so its leading fragment reached `raw` in clear (B-540).
 * The `…` suffix is added exactly when text was dropped.
 *
 * Redaction sees at most the first 64 KiB of the body, which bounds its
 * cost on a body of any size, a pattern registered with
 * `Security.addPattern` included. A credential cut by that bound is left
 * in clear at the end of the redacted text, and redaction can shrink the
 * text before it enough to pull it inside the cut, so a capped body also
 * drops the last 16 KiB of its redacted text. The cut never splits a
 * surrogate pair.
 *
 * Post T1.1 (secret-redaction-discipline, ADR D68): every error metadata
 * goes through `redactSecrets` before exposure. Note the shape change —
 * pre-T1.1 the function preserved the original `body` shape when ≤2KB;
 * now it always returns a (possibly redacted) string, because redaction
 * coerces non-strings to JSON. Consumers who used to do `err.metadata.raw.foo`
 * must now `JSON.parse(err.metadata.raw)` first — but a workspace-wide
 * grep at T1.1 land time confirmed zero such callers.
 *
 * @internal
 */
export function truncateRaw(body: unknown): unknown {
  if (body === null || body === undefined) return undefined;
  const s = typeof body === "string" ? body : JSON.stringify(body);
  if (s.length <= REDACT_INPUT_CAP) {
    const redacted = redactSecrets(s);
    return redacted.length <= RAW_MAX_CHARS ? redacted : `${cutAt(redacted, RAW_MAX_CHARS)}…`;
  }
  const redacted = redactSecrets(s.slice(0, REDACT_INPUT_CAP));
  const kept = cutAt(redacted, Math.max(0, redacted.length - CAP_EDGE_MARGIN));
  return `${cutAt(kept, RAW_MAX_CHARS)}…`;
}

/** The first `end` code units of `text`, one fewer when that would split a surrogate pair. */
function cutAt(text: string, end: number): string {
  if (end >= text.length) return text;
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/**
 * Build an `ErrorMetadata` object with all optional fields included
 * conditionally (no `undefined` keys in the output). Caller passes
 * dialect-specific fields (`provider`, `endpoint`, `code`); shared
 * fields (`statusCode`, `retryAfter`, `raw`) are derived here.
 *
 * @internal
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

/**
 * D314: extract the provider's request id (`x-request-id` is OpenAI/most;
 * `request-id` is Anthropic). Returns `undefined` when neither is present.
 *
 * @internal
 */
export function parseRequestId(headers: Headers | undefined): string | undefined {
  if (headers === undefined) return undefined;
  return headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
}

/**
 * The HTTP status ladder — ONE definition, shared by every provider mapper.
 *
 * This is RFC 9110 semantics, not a vendor contract: a 429 means the same thing
 * whether Anthropic, OpenAI, Bedrock or Vertex sent it. It lived in four copies
 * until 2026-09-01 and the copies had already drifted in two measurable ways,
 * which is what moved it here beside the other dialect-agnostic helpers ADR D67
 * extracted:
 *
 *  1. **402 reached one mapper of four.** T3.7 added `quota_exceeded` and wired
 *     it into `openai-compatible.ts` only. A Bedrock, Vertex or Anthropic
 *     endpoint answering 402 fell through every arm and came back `unknown` —
 *     the canonical bucket existed and three of four mappers could not reach it.
 *  2. **The 5xx arm had two different upper bounds.** `anthropic` and
 *     `openai-compatible` guarded `>= 500 && < 600`; `bedrock` and `vertex`
 *     guarded `>= 500` with no ceiling, so a malformed or proxy-injected 6xx was
 *     `server_error` in two mappers and `unknown` in the other two.
 *
 * Neither was a vendor difference. Both were copy-drift, and that is the DRY
 * test in its textbook form: one piece of knowledge, four places to change it.
 *
 * The ladder is deliberately the FALLBACK, never the whole classifier. Each
 * mapper keeps its own body-dialect rules — Anthropic's `context_too_long`,
 * Bedrock's AWS `__type` strings, Vertex's `google.rpc` status enum — because
 * those ARE per-vendor contracts. The shape is
 * `classifyVendorBody(body) ?? httpStatusToErrorCode(status)`.
 *
 * 404 is deliberately NOT mapped here. Three mappers treat it as `unknown` and
 * Bedrock treats it as `invalid_request` via its own `__type` rules; folding it
 * in would silently change three mappers to close a divergence nobody measured.
 *
 * @internal
 */
export type HttpStatusErrorCode = Extract<
  ErrorCode,
  | "auth_failed"
  | "quota_exceeded"
  | "timeout"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
>;

export function httpStatusToErrorCode(status: number): HttpStatusErrorCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402) return "quota_exceeded";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 400) return "invalid_request";
  if (status >= 500 && status < 600) return "server_error";
  return "unknown";
}

/**
 * Reads an error body that may arrive already parsed, as a JSON string, or as neither.
 *
 * This is TRANSPORT knowledge, not vendor knowledge: it describes how `fetch` surfaces a body, which
 * is the same whichever provider sent it. It lived twice, character-for-character, in bedrock.ts and
 * vertex.ts — identical once the return type name was substituted. They had not drifted, so the cost
 * was only latent: a fix to one would have missed the other silently.
 *
 * Unparseable input yields `{}` rather than throwing, because a mapper's job is to classify a
 * failure that already happened; failing to read the body is not a second failure to report.
 */
export function parseErrorBody<T>(body: unknown): T {
  if (body !== null && typeof body === "object") return body as T;
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}
