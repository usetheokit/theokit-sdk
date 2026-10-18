/**
 * Real-LLM CI matrix env-gating helpers (T0.2 of plan `sdk-superiority-2026-06-07`).
 *
 * Every test under `tests/integration/real-llm/<provider>-<scenario>.test.ts`
 * uses `describe.skipIf(...)` to silence the suite when the required
 * provider key is not set. Without these helpers each file duplicates the
 * env probe logic; we centralize so CI matrix expansion (T6.1) only needs
 * to flip a single allowlist.
 *
 * Per SEPA initial brief § C cost-budget: gpt-4o-mini via OpenRouter is the
 * default. T3.5 (Anthropic native caching) and T3.6 (OpenAI native structured
 * outputs) provider-specific scenarios route via direct base URLs when their
 * dedicated key is present, falling back to OpenRouter for the routing test
 * surface (NOT the native-capability test surface).
 *
 * @internal
 */

/** Provider keys this matrix knows how to consume. */
type RealLlmProvider = "openai" | "anthropic" | "openrouter";

interface RealLlmHandle {
  /** Vitest `skipIf` boolean — true means SKIP. */
  readonly shouldSkip: boolean;
  /** Reason the suite was skipped (empty when shouldSkip === false). */
  readonly skipReason: string;
  /** Provider routing label this handle resolved to. */
  readonly provider: RealLlmProvider;
  /** Default model identifier for the resolved provider. */
  readonly model: string;
  /** Resolved API key (empty when shouldSkip === true). */
  readonly apiKey: string;
  /** Resolved base URL (empty for default OpenRouter routing). */
  readonly baseUrl: string;
}

const KEYS: Record<RealLlmProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const DEFAULT_MODELS: Record<RealLlmProvider, string> = {
  openai: "openai/gpt-4o-mini",
  anthropic: "anthropic/claude-3-5-haiku-latest",
  openrouter: "openai/gpt-4o-mini",
};

/**
 * Models used when a provider's own key is missing and the call goes through OpenRouter instead.
 * OpenRouter names models with its own slugs, so the native id does not always exist there:
 * `anthropic/claude-3-5-haiku-latest` is refused with "not a valid model ID" (HTTP 400), checked
 * against https://openrouter.ai/api/v1/models on 2026-10-18 (#719).
 */
const OPENROUTER_FALLBACK_MODELS: Record<RealLlmProvider, string> = {
  openai: "openai/gpt-4o-mini",
  anthropic: "anthropic/claude-haiku-4.5",
  openrouter: "openai/gpt-4o-mini",
};

const OPENROUTER_ROUTE_PREFIX = "openrouter/";

const DEFAULT_BASE_URLS: Record<RealLlmProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "",
};

/**
 * Resolve the env-handle for a (provider, scenario) test. When the direct
 * provider key is missing AND the scenario does not require native-only
 * features, fall back to OpenRouter routing. Native-only scenarios pass
 * `nativeOnly: true` to force-skip without OpenRouter fallback.
 */
export function resolveRealLlmEnv(
  provider: RealLlmProvider,
  options: { nativeOnly?: boolean; model?: string } = {},
): RealLlmHandle {
  const providerKey = process.env[KEYS[provider]];
  if (providerKey !== undefined && providerKey.length > 0) {
    return {
      shouldSkip: false,
      skipReason: "",
      provider,
      model: options.model ?? DEFAULT_MODELS[provider],
      apiKey: providerKey,
      baseUrl: DEFAULT_BASE_URLS[provider],
    };
  }
  if (options.nativeOnly === true) {
    return {
      shouldSkip: true,
      skipReason: `${KEYS[provider]} not set (native-only scenario; OpenRouter fallback disabled)`,
      provider,
      model: options.model ?? DEFAULT_MODELS[provider],
      apiKey: "",
      baseUrl: "",
    };
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey !== undefined && openrouterKey.length > 0) {
    return {
      shouldSkip: false,
      skipReason: "",
      provider: "openrouter",
      model: openrouterRoutedModel(options.model ?? OPENROUTER_FALLBACK_MODELS[provider]),
      apiKey: openrouterKey,
      baseUrl: "",
    };
  }
  return {
    shouldSkip: true,
    skipReason: `Neither ${KEYS[provider]} nor OPENROUTER_API_KEY is set`,
    provider,
    model: options.model ?? DEFAULT_MODELS[provider],
    apiKey: "",
    baseUrl: "",
  };
}

/**
 * The `openrouter/` prefix is what routes the call. A bare `anthropic/...` id makes Agent.create
 * check the OpenRouter key against the native Anthropic provider and throw malformed_api_key
 * (#719). A bare `openai/...` id only got through because "sk-or-" happens to start with OpenAI's
 * "sk-".
 */
function openrouterRoutedModel(model: string): string {
  return model.startsWith(OPENROUTER_ROUTE_PREFIX) ? model : `${OPENROUTER_ROUTE_PREFIX}${model}`;
}
