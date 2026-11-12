/**
 * T1.3 — API key boundary validation.
 *
 * `validateApiKeyShape(key, provider?)` runs at the create-agent boundary
 * and rejects malformed inputs early (whitespace-only strings, sub-16-char
 * fragments, embedded whitespace, missing-prefix shapes for providers that
 * stamp a known prefix). The check is shape-only — it does NOT make a
 * round-trip to the provider; live validation still happens at the first
 * `fetch` against the provider URL.
 *
 * Exempted from shape validation:
 * - fixture keys (prefix `theo_test_`) — used by SDK consumers' fixture-mode tests.
 * - local-runtime mock key `"local"` — used by Ollama / LMStudio / llama.cpp
 *   sibling profiles (ADRs D182/D188/D189) whose `authType` is `"none"`.
 *
 * @internal
 */

const FIXTURE_KEY_PREFIX = "theo_test_";
/**
 * The sentinel key that forces the local runtime without a real provider
 * credential. Exported so callers threading an explicit `apiKey` into the
 * provider router can skip it (it is not a real credential). @internal
 */
export const LOCAL_RUNTIME_MOCK_KEY = "local";
const MIN_KEY_LENGTH = 16;

interface ProviderPrefixHint {
  /** Substring (case-sensitive) that legitimate keys for this provider start with. */
  prefix: string;
  /** Provider canonical name used by the boundary helper for error messages. */
  provider: string;
}

const KNOWN_PROVIDER_PREFIXES: ProviderPrefixHint[] = [
  { provider: "openai", prefix: "sk-" },
  { provider: "anthropic", prefix: "sk-ant-" },
  { provider: "openrouter", prefix: "sk-or-" },
];

export interface ApiKeyValidationFailure {
  readonly malformed: true;
  readonly reason:
    | "empty"
    | "whitespace_only"
    | "too_short"
    | "embedded_whitespace"
    | "missing_known_prefix";
  readonly message: string;
}

export interface ApiKeyValidationOk {
  readonly malformed: false;
}

export type ApiKeyValidationResult = ApiKeyValidationOk | ApiKeyValidationFailure;

export interface ValidateApiKeyOptions {
  /** Provider name (lowercase) for prefix sanity check. */
  provider?: string;
  /**
   * When `false`, only empty and whitespace-only keys are rejected (a short
   * placeholder key is legitimate for a provider the SDK cannot attribute). Set when the caller knows the value is just an
   * identifier (e.g., `shouldUseRealLocalRuntime` mode where the real HTTP
   * call uses an env credential instead of this `apiKey`).
   *
   * When `true` (default), the full shape check applies: 16-char minimum,
   * provider-prefix sanity, no embedded whitespace.
   */
  strict?: boolean;
}

/**
 * Validate the shape of an API key. Returns a discriminated result; the
 * boundary caller (`agent.ts createLocalAgent` / `createCloudAgent`) throws
 * `AuthenticationError({code:"malformed_api_key"})` on failure.
 */
export function validateApiKeyShape(
  key: string | undefined,
  options: ValidateApiKeyOptions | string = {},
): ApiKeyValidationResult {
  // Back-compat: legacy callers pass a bare `provider` string as 2nd arg.
  const opts: ValidateApiKeyOptions = typeof options === "string" ? { provider: options } : options;
  const tier1 = checkTier1(key, opts.strict !== false);
  if (tier1.malformed) return tier1;
  // Tier 1 succeeded → key is a non-empty string; narrow it.
  const validKey = key as string;
  if (validKey.startsWith(FIXTURE_KEY_PREFIX) || validKey === LOCAL_RUNTIME_MOCK_KEY) {
    return { malformed: false };
  }
  if (opts.strict === false) return { malformed: false };
  return checkTier2(validKey, opts.provider);
}

function checkTier1(key: string | undefined, enforceMinLength: boolean): ApiKeyValidationResult {
  if (key === undefined || key.length === 0) {
    return { malformed: true, reason: "empty", message: "API key is empty." };
  }
  if (key.trim().length === 0) {
    return {
      malformed: true,
      reason: "whitespace_only",
      message: "API key contains only whitespace.",
    };
  }
  if (enforceMinLength && key.length < 4) {
    return {
      malformed: true,
      reason: "too_short",
      message: `API key must be at least 4 chars (got ${key.length}).`,
    };
  }
  return { malformed: false };
}

function checkTier2(key: string, provider: string | undefined): ApiKeyValidationResult {
  if (key.length < MIN_KEY_LENGTH) {
    return {
      malformed: true,
      reason: "too_short",
      message: `API key must be at least ${MIN_KEY_LENGTH} chars (got ${key.length}).`,
    };
  }
  if (/\s/.test(key)) {
    return {
      malformed: true,
      reason: "embedded_whitespace",
      message: "API key contains embedded whitespace.",
    };
  }
  return checkProviderPrefix(key, provider);
}

function checkProviderPrefix(key: string, provider: string | undefined): ApiKeyValidationResult {
  if (provider === undefined) return { malformed: false };
  const hint = KNOWN_PROVIDER_PREFIXES.find((p) => p.provider === provider.toLowerCase());
  if (hint === undefined) return { malformed: false };
  if (!key.startsWith(hint.prefix)) {
    return {
      malformed: true,
      reason: "missing_known_prefix",
      message: `API key for provider "${hint.provider}" expected to start with "${hint.prefix}".`,
    };
  }
  return { malformed: false };
}
