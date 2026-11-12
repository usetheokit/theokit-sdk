/**
 * Provider inference helpers for the real local run — extracted from
 * `real-local-run.ts` to keep it within the G8 LoC budget and give the
 * "which provider?" heuristics one cohesive home.
 *
 * The precedence diagnostic joined them for the same two reasons: it answers the same question
 * ("which provider, and was that what the caller asked for?"), and adding it inline pushed
 * `real-local-run.ts` to 411 LoC against the 400 budget. The gate asked for a split and this is
 * where the split already lives.
 *
 * @internal
 */

import { providerFromApiKeyPrefix } from "../auth/api-key-prefix.js";
import { LOCAL_RUNTIME_MOCK_KEY } from "../auth/api-key-validator.js";
import { diag } from "../diagnostics.js";
import { parseModelId } from "../llm/model-identifier.js";
import { getProviderProfile, registerBuiltins } from "../providers/index.js";
import { registerPluginProviderProfiles } from "../providers/register-plugin-providers.js";
import { isFixtureApiKey } from "../runtime/fixtures/fixture-mode.js";
import type { CreateRealLocalRunOptions } from "./real-local-run-options.js";

/** Vendors whose model prefix a vendor-specific key prefix may overrule. */
const BUILTIN_VENDORS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "openrouter",
  "gemini",
]);

/**
 * A key only outranks a model prefix when the key identifies ONE vendor (`sk-or-`, `sk-ant-`)
 * and the prefix names a built-in vendor. A bare `sk-` is shared by OpenAI and many compatible
 * gateways, and a prefix naming a provider the app registered itself is an explicit choice;
 * neither may be overruled by the key (#1115).
 */
function keyProviderForModel(
  apiKey: string | undefined,
  modelProvider: string | undefined,
): string | undefined {
  const inferred = inferProviderFromApiKey(apiKey);
  if (modelProvider === undefined) return inferred;
  const key = apiKey?.trim() ?? "";
  const vendorSpecific = key.startsWith("sk-or-") || key.startsWith("sk-ant-");
  return vendorSpecific && BUILTIN_VENDORS.has(modelProvider) ? inferred : undefined;
}

/**
 * The provider a key belongs to, **restricted to providers this runtime can construct**.
 *
 * The prefix table moved to `auth/api-key-prefix.ts` and is no longer duplicated here — it was the
 * same knowledge in two places, and the copy here relied on its entries being hand-written in
 * longest-first order to be correct at all. What stays is the part that is genuinely this path's
 * policy: the local run will not name a provider it has no profile for.
 *
 * @internal
 */
export function inferProviderFromApiKey(apiKey: string | undefined): string | undefined {
  const provider = providerFromApiKeyPrefix(apiKey);
  if (provider === undefined) return undefined;
  return getProviderProfile(provider) === undefined ? undefined : provider;
}

/**
 * The default primary provider from the environment: the first of
 * ANTHROPIC / OPENAI / OPENROUTER with a non-empty key, else `openai`.
 *
 * @internal
 */
export function detectPrimaryProvider(): string {
  if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY.length > 0) {
    return "anthropic";
  }
  if (process.env.OPENAI_API_KEY !== undefined && process.env.OPENAI_API_KEY.length > 0) {
    return "openai";
  }
  if (process.env.OPENROUTER_API_KEY !== undefined && process.env.OPENROUTER_API_KEY.length > 0) {
    return "openrouter";
  }
  return "openai";
}

/**
 * Warns once per (asked, used) pair when the resolved provider is not the one the model id named.
 *
 * One-shot per pair, mirroring `warnNoAuthApiKeysIgnoredOnce` in `router.ts` — the same "your
 * input was ignored, here is why" shape, and a per-request warning is one nobody reads.
 *
 * Silent when the model id carried no provider prefix, or when the prefix IS what was used: an
 * override that did not happen is not news.
 *
 * @internal
 */
const warnedProviderPrecedence = new Set<string>();
export function warnProviderPrecedenceOnce(asked: string | undefined, used: string): void {
  if (asked === undefined || asked === used) return;
  const key = `${asked}->${used}`;
  if (warnedProviderPrecedence.has(key)) return;
  warnedProviderPrecedence.add(key);
  diag(
    `[theokit-sdk] model id names provider "${asked}", but "${used}" was used — an explicit ` +
      "`providers.routes[0]` or the API key's own prefix outranks the model id's prefix. " +
      "Pass `providers.routes` to choose deliberately.\n",
  );
}

/** Test-only reset. @internal */
export function _resetProviderPrecedenceWarnings(): void {
  warnedProviderPrecedence.clear();
}

/**
 * MOVED HERE 2026-09-02 from `real-local-run.ts`, which was the largest file in the slice and held
 * six concerns. This is one of them: the four-level provider precedence — explicit route, then the
 * key's prefix, then the model's prefix, then env-var detection — plus the credential merge that
 * follows from it. Its neighbours in this file (`inferProviderFromApiKey`, `detectPrimaryProvider`,
 * `warnProviderPrecedenceOnce`) are the steps it composes, so the seam already existed; only the
 * composition was on the other side of it.
 */

// Module-level one-shot: the observability line fires once per process, not
// once per run, to avoid log spam when many agents are created.
let pluginProvidersAnnounced = false;

/** Test-only reset for the one-shot announcement. @internal */
export function _resetPluginProviderAnnounce(): void {
  pluginProvidersAnnounced = false;
}

/**
 * Resolve the run's primary provider + effective model id.
 *
 * Registers builtins AND any plugin-contributed `kind: "model-provider"`
 * profiles FIRST, so the prefix-inference lookup (`model: { id: "myprov/..." }`)
 * can see a plugin-supplied provider. The aggregated profiles were otherwise
 * never registered (half-wired path). Extracted from `buildLoopInputs` (SRP)
 * and exported `@internal` so the plugin-provider wiring is regression-covered.
 *
 * ADR D182 / T1.2: explicit `providers.routes[0].provider` wins, then prefix
 * inference, then env-var heuristics (`detectPrimaryProvider`).
 *
 * @internal
 */
export function resolveRunProvider(options: CreateRealLocalRunOptions): {
  primary: string;
  effectiveModelId: string;
} {
  registerBuiltins();
  const profiles = options.pluginManager?.aggregated.providerProfiles ?? [];
  const registered = registerPluginProviderProfiles(profiles);
  // Wiring-triad pillar (c): one-shot observability that plugin providers were
  // wired this process. Silent on the zero-plugin happy path.
  if (registered > 0 && !pluginProvidersAnnounced) {
    pluginProvidersAnnounced = true;
    const names = profiles.map((e) => e.profile.name).join(", ");
    diag(`[theokit-sdk] registered ${registered} plugin provider profile(s): ${names}\n`);
  }
  const parsedModel = parseModelId(options.model?.id);
  const modelInferredProvider =
    parsedModel.provider !== undefined && getProviderProfile(parsedModel.provider) !== undefined
      ? parsedModel.provider
      : undefined;
  // M4 (plan m4-provider-routing-apikey-fix): the explicitly-passed API key is
  // the ground-truth credential of which endpoint will be called, so it outranks
  // model-prefix inference for `primary` — a `sk-or-` key + an `openai/gpt-4o-mini`
  // model MUST route to OpenRouter, not the OpenAI provider. An explicit
  // `providers.routes[0].provider` still wins (user override).
  const keyInferredProvider = keyProviderForModel(
    options.agentOptions.apiKey,
    modelInferredProvider,
  );
  const primary =
    options.agentOptions.providers?.routes?.[0]?.provider ??
    keyInferredProvider ??
    modelInferredProvider ??
    detectPrimaryProvider();
  // The precedence above is deliberate, but it used to be silent: a caller writing
  // `model: { id: "e2elocal/gpt-4o-mini" }` and receiving `openai API error: auth_failed` had no
  // way to learn their prefix had been overruled, because the error names only the winner
  // (B-156). `error-handling.md` § 2 asks that a substitution be visible.
  warnProviderPrecedenceOnce(modelInferredProvider, primary);
  // Strip the vendor prefix ONLY when the model's own prefix names the resolved
  // primary (anthropic/claude → claude for the anthropic provider). When primary
  // is an aggregator (openrouter) whose slug legitimately embeds a `vendor/`
  // segment (openai/gpt-4o-mini), pass the id through unstripped.
  const effectiveModelId =
    modelInferredProvider !== undefined && modelInferredProvider === primary
      ? parsedModel.name
      : (options.model?.id ?? "claude-sonnet-4-6");
  return { primary, effectiveModelId };
}

/**
 * M4: thread the single `Agent.create({ apiKey })` credential into the router's
 * per-provider pool for the resolved `primary`, so an explicitly-passed key is
 * used even when the matching env var is unset. An existing `providers.apiKeys`
 * pool for the provider wins (it is the more-specific config); fixture and
 * `local` sentinels are never threaded (they are not real credentials). @internal
 */
export function mergeExplicitApiKey(
  pools: Record<string, string[]> | undefined,
  primary: string,
  apiKey: string | undefined,
): Record<string, string[]> | undefined {
  if (apiKey === undefined || apiKey.length === 0) return pools;
  if (isFixtureApiKey(apiKey) || apiKey === LOCAL_RUNTIME_MOCK_KEY) return pools;
  const existing = pools?.[primary];
  if (existing !== undefined && existing.length > 0) return pools;
  return { ...(pools ?? {}), [primary]: [apiKey] };
}
