/**
 * G5 T2.2 boundary translation — `@theokit/sdk/server/errors-envelope`.
 *
 * Per plan g5-error-envelope-cross-layer v1.0 § Phase 2 / T2.2.
 * Blueprint ADR D3 — SDK keeps the 15+ Error class hierarchy internally;
 * `toEnvelope(err)` translates outward at the Agent.send -> RunResult egress
 * edge, `fromEnvelope(env)` reconstructs class identity on the inbound edge
 * (so consumer code can keep using `instanceof RateLimitError` patterns).
 *
 * Structurally-compatible envelope shape: identical fields to theokit/server
 * `TheoErrorEnvelope`. Re-declared locally to keep `@theokit/sdk` free of any
 * dependency on `theokit`. Consumer code that uses both packages gets the
 * same shape via duck-typing.
 */

import {
  AgentRunError,
  AuthenticationError,
  ConfigurationError,
  CredentialPoolExhaustedError,
  MemoryAdapterError,
  NetworkError,
  RateLimitError,
  TheokitAgentError,
  UnknownAgentError,
} from "../errors.js";

/**
 * Canonical envelope code union for cross-layer SDK boundary. Subset of the
 * full `TheoErrorCode` (theokit/server) covering codes the SDK actually emits.
 * Other layers (theokit/server, theokit/client, theokit/ui) handle the broader
 * union; the SDK never needs the HTTP-only codes (PRECONDITION_FAILED, etc.).
 *
 * @public
 */
export type TheokitErrorCode =
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "INTERNAL_SERVER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "GATEWAY_TIMEOUT"
  // SDK / agent-domain
  | "AGENT_RUN_ERROR"
  | "PROVIDER_KEY_MISSING"
  | "BUDGET_EXCEEDED"
  | "CREDENTIAL_POOL_EXHAUSTED";

/**
 * Envelope shape — structurally identical to theokit/server `TheoErrorEnvelope`.
 *
 * @public
 */
export interface TheokitErrorEnvelope<TExt = unknown> {
  readonly code: TheokitErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly meta?: Record<string, unknown>;
  readonly ext?: TExt;
}

/**
 * Class-name -> envelope code mapping. Indexed by `Error.name` string so
 * subclasses inherit the mapping unless they override their `name` field.
 *
 * `IntegrationNotConnectedError` (subclass of `ConfigurationError`) takes
 * its own row because its `name` is `IntegrationNotConnectedError` and the
 * map is name-exact, not prototype-walked.
 */
const NAME_TO_CODE: ReadonlyMap<string, TheokitErrorCode> = new Map<string, TheokitErrorCode>([
  ["AuthenticationError", "UNAUTHORIZED"],
  ["RateLimitError", "RATE_LIMITED"],
  ["ConfigurationError", "PROVIDER_KEY_MISSING"],
  ["IntegrationNotConnectedError", "PROVIDER_KEY_MISSING"],
  ["NetworkError", "SERVICE_UNAVAILABLE"],
  ["AgentRunError", "AGENT_RUN_ERROR"],
  ["BudgetExceededError", "BUDGET_EXCEEDED"],
  ["CredentialPoolExhaustedError", "CREDENTIAL_POOL_EXHAUSTED"],
  ["UnknownAgentError", "INTERNAL_SERVER_ERROR"],
  ["MemoryAdapterError", "INTERNAL_SERVER_ERROR"],
]);

/**
 * Translate any SDK error (or arbitrary thrown value) into the canonical
 * envelope shape at the wire boundary.
 *
 * - `TheokitAgentError` family → mapped by `Error.name` string.
 * - Plain `Error` → INTERNAL_SERVER_ERROR.
 * - Non-Error values → INTERNAL_SERVER_ERROR with synthetic message.
 *
 * Meta carries `sdkErrorName` for telemetry; provider metadata (when present
 * via SDK's `ErrorMetadata`) flows through `meta.provider` / `meta.endpoint`
 * / `meta.statusCode` for diagnostics. `RateLimitError` populates a
 * `RetryableExt`-shaped ext when `metadata.retryAfter` (seconds) is set.
 *
 * @public
 */
export function toEnvelope(value: unknown): TheokitErrorEnvelope {
  if (!(value instanceof Error)) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: typeof value === "string" ? value : "Unknown error",
    };
  }
  const name = value.name;
  const code = NAME_TO_CODE.get(name) ?? "INTERNAL_SERVER_ERROR";
  const meta = buildMeta(name, value);
  const ext = buildExt(value);
  return {
    code,
    message: value.message,
    cause: (value as Error & { cause?: unknown }).cause,
    meta,
    ext,
  };
}

function buildMeta(name: string, err: Error): Record<string, unknown> {
  const meta: Record<string, unknown> = { sdkErrorName: name };
  if (err instanceof TheokitAgentError && err.metadata !== undefined) {
    meta.provider = err.metadata.provider;
    meta.endpoint = err.metadata.endpoint;
    if (err.metadata.statusCode !== undefined) {
      meta.statusCode = err.metadata.statusCode;
    }
  }
  return meta;
}

function buildExt(err: Error): unknown {
  if (err instanceof RateLimitError && err.metadata?.retryAfter !== undefined) {
    return {
      retryable: true as const,
      retryAfterMs: err.metadata.retryAfter * 1000,
    };
  }
  if (err instanceof CredentialPoolExhaustedError && err.nextRetryAt !== undefined) {
    const delayMs = Math.max(0, err.nextRetryAt - Date.now());
    return {
      retryable: true as const,
      retryAfterMs: delayMs,
    };
  }
  return undefined;
}

/**
 * Code -> reconstructor mapping. Each entry returns a fresh instance of the
 * SDK class hierarchy from an envelope, preserving message and (where the
 * constructor supports it) cause/ext context.
 *
 * Unmapped codes fall through to `UnknownAgentError` so consumer code that
 * relies on `err instanceof TheokitAgentError` still works.
 */
const CODE_TO_RECONSTRUCTOR: ReadonlyMap<
  TheokitErrorCode,
  (env: TheokitErrorEnvelope) => TheokitAgentError
> = new Map<TheokitErrorCode, (env: TheokitErrorEnvelope) => TheokitAgentError>([
  ["UNAUTHORIZED", (env) => new AuthenticationError(env.message)],
  [
    "RATE_LIMITED",
    (env) => new RateLimitError(env.message, env.cause !== undefined ? { cause: env.cause } : {}),
  ],
  ["PROVIDER_KEY_MISSING", (env) => new ConfigurationError(env.message)],
  ["SERVICE_UNAVAILABLE", (env) => new NetworkError(env.message)],
  ["GATEWAY_TIMEOUT", (env) => new NetworkError(env.message)],
  [
    "AGENT_RUN_ERROR",
    (env) =>
      new AgentRunError(env.message, {
        code: "unknown",
        ...(env.cause !== undefined ? { cause: env.cause } : {}),
      }),
  ],
  ["INTERNAL_SERVER_ERROR", (env) => new UnknownAgentError(env.message)],
  // BUDGET_EXCEEDED + CREDENTIAL_POOL_EXHAUSTED reconstructors require
  // domain-specific args (budgetName, provider) that the envelope doesn't
  // always carry. Fall back to UnknownAgentError when those fields are
  // missing; consumer code that needs the typed class should call the
  // constructor directly.
]);

/**
 * Hydrate an envelope back into the SDK class hierarchy. Use at the inbound
 * boundary (e.g., on a worker process receiving an envelope from the main
 * process via IPC, or on a client deserializing a `RunResult.error`).
 *
 * @public
 */
export function fromEnvelope(env: TheokitErrorEnvelope): TheokitAgentError {
  const reconstructor = CODE_TO_RECONSTRUCTOR.get(env.code);
  if (reconstructor) return reconstructor(env);
  // Round-trip preservation: if the envelope's meta.sdkErrorName matches a
  // class without a generic reconstructor (e.g., BudgetExceededError), we
  // can't rebuild without domain args. Fall back to UnknownAgentError.
  return new UnknownAgentError(env.message);
}

// Re-export for ergonomic consumption alongside fromEnvelope.
export { MemoryAdapterError };
