import { ConfigurationError } from "../../errors.js";
import { diag } from "../diagnostics.js";
import {
  getProviderProfile,
  listProviders,
  type ProviderProfile,
  registerBuiltins,
} from "../providers/index.js";
import { AnthropicClient } from "./anthropic.js";
import { BedrockAnthropicClient } from "./bedrock-anthropic.js";
import { CredentialPool, newPooledCredential } from "./credential-pool.js";
import { currentCredentialPool } from "./credential-pool-context.js";
import type { CredentialPoolStrategy } from "./credential-pool-types.js";
import { maybeWrapWithFaultInjection } from "./fault-injection.js";
import { OllamaNativeClient } from "./ollama-native.js";
import { OpenAIClient } from "./openai.js";
import { PoolAwareLlmClient } from "./pool-aware-client.js";
import { ResponsesApiClient } from "./responses.js";
import { RetryingLlmClient } from "./retrying-client.js";
import type { LlmClient } from "./types.js";
import { VertexRouterClient } from "./vertex-router.js";

/**
 * Provider router (T4.3, ADRs D105-D107).
 *
 * Resolves an `LlmClient` from a `ProviderProfile`. The profile is the
 * data; the transport is selected by `apiMode`. Builtins are eagerly
 * registered on first call; user plugins in `~/.theokit/plugins/
 * model-providers/` are lazy-loaded.
 *
 * @internal
 */

export type ProviderName = "anthropic" | "openai" | "openrouter" | (string & {});

export interface ProviderRouterOptions {
  primary: ProviderName;
  fallback?: ProviderName[];
  /** Credential pools per provider (ADRs D123-D133). Optional. */
  apiKeys?: Record<string, string[]>;
  /** Pool rotation strategy per provider. Optional; default `"fill_first"`. */
  credentialPoolStrategy?: Record<string, CredentialPoolStrategy>;
  /**
   * Per-run opt-in leaked-dialect safe-parse derived from the chat route
   * (theokit#58 follow-up). When `true`, the resolved profile is cloned with
   * `extractToolCallsFromContent: true` so the OpenAI-compatible transport
   * recovers Hermes `<function=…></tool_call>` dialect leaked as text. Applied
   * to the resolved chain; fail-open, so a non-leaking provider is unaffected.
   */
  extractToolCallsFromContent?: boolean;
  /**
   * SE2 — forwarded into the pool-aware client so a 429 retry surfaces a
   * `rate_limit` RunEvent. Wired from `SendOptions.onRunEvent` at the run boundary.
   */
  onRateLimit?: (info: { attempt: number; retryAfterMs?: number }) => void;
  /**
   * #332 — the endpoint THIS call should reach, from `ModelSelection.url`.
   *
   * It outranks the provider's base-URL env var deliberately. `OLLAMA_HOST` and friends are
   * process-wide, so with the env var winning, whoever set it for one model would keep hijacking
   * every other one — which is the bug this field exists to end, wearing a hat.
   */
  baseUrl?: string;
}

/**
 * Resolves the provider chain synchronously. Builtins are eagerly registered.
 * Provider plugin discovery is expected to have run upfront (e.g., via
 * Agent.create initialization) before this is called.
 */
export function resolveProviderChain(options: ProviderRouterOptions): LlmClient[] {
  registerBuiltins();
  return buildChain(options);
}

function buildChain(options: ProviderRouterOptions): LlmClient[] {
  // EC-B: warn (once) on apiKeys entries for providers we don't recognize.
  warnUnknownProvidersInApiKeys(options.apiKeys);

  const seen = new Set<string>();
  const clients: LlmClient[] = [];
  // `perCallBaseUrl` reaches ONLY the provider the model id names. It comes from
  // `ModelSelection.url`, documented above as "the endpoint THIS call should reach" — and a
  // fallback provider is a different endpoint by definition. Handing it to every client made a
  // fallback inherit the primary's host, so it could never reach its own: measured at primary 6
  // requests / fallback 0 (B-151). The irony was on the record — this field exists to stop a
  // process-wide setting hijacking models it was not meant for, and within a chain it was doing
  // exactly that itself.
  const addClient = (name: ProviderName, perCallBaseUrl?: string): void => {
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) return;
    seen.add(lowered);
    const client = buildClient(lowered, options, perCallBaseUrl);
    // D14: wrap every resolved client with the fault-injection decorator.
    // The wrapper is a cheap noop unless `NODE_ENV=test` AND
    // `THEOKIT_TEST_RESPONSE_OVERRIDE` are both set — production is unaffected.
    if (client !== undefined) clients.push(maybeWrapWithFaultInjection(client));
  };
  addClient(options.primary, options.baseUrl);
  // No `perCallBaseUrl`: each fallback resolves its own endpoint from its profile and its own
  // `*_API_BASE_URL`, which is what makes a fallback a different destination rather than a retry.
  for (const fallback of options.fallback ?? []) addClient(fallback);
  if (clients.length === 0) {
    // Lowercased exactly as `addClient` does, so a name that differs from a profile only in case
    // stays a registered provider and keeps the credentials hint below.
    if (getProviderProfile(options.primary.toLowerCase()) === undefined) {
      throw new ConfigurationError(unregisteredProviderMessage(options.primary), {
        code: "provider_unresolved",
      });
    }
    throw new ConfigurationError(
      `No provider client could be resolved (primary=${options.primary}). ` +
        `Set ANTHROPIC_API_KEY or OPENAI_API_KEY / OPENROUTER_API_KEY.`,
      { code: "provider_unresolved" },
    );
  }
  return clients;
}

/**
 * The primary names no profile, so no key could have helped: say so, and list the names that do
 * resolve. Read at throw time, so a profile registered by a plugin for this send is listed too.
 */
function unregisteredProviderMessage(name: string): string {
  const registered = listProviders()
    .map((profile) => profile.name)
    .sort()
    .join(", ");
  return (
    `No provider client could be resolved: "${name}" is not a known provider. ` +
    `Registered providers: ${registered}.`
  );
}

/**
 * Resolves the transport for `name` — every arm returns it RAW.
 *
 * Retry is applied ONCE, by {@link buildClient}, and that split is the point. Three arms wrapped
 * themselves and a fourth did not: `maybeBuildNoAuthTransport` returned an unwrapped transport, so an
 * Ollama / LM Studio / llama.cpp user passing a placeholder key got zero retries on a transient 5xx
 * while every other configuration retried. The sweep that fixed the other three found them one at a
 * time — its own comment records the third being discovered while testing the second — and a fourth
 * was always going to be possible while each arm opted in for itself.
 *
 * A new return path added here cannot opt out of resilience by omission.
 */
function buildTransport(
  name: string,
  routerOptions: ProviderRouterOptions,
  perCallBaseUrl?: string,
): LlmClient | undefined {
  const baseProfile = getProviderProfile(name);
  if (baseProfile === undefined) return undefined;
  // theokit#58 follow-up: per-run route opt-in clones the resolved profile with
  // the leaked-dialect recovery flag so the OpenAI-compatible transport surfaces
  // Hermes `<function=…></tool_call>` calls leaked as text. Built-in profiles
  // ship the flag off; this is the per-run enablement path.
  const profile =
    routerOptions.extractToolCallsFromContent === true &&
    baseProfile.extractToolCallsFromContent !== true
      ? { ...baseProfile, extractToolCallsFromContent: true }
      : baseProfile;
  const resilience =
    routerOptions.onRateLimit !== undefined ? { onRateLimit: routerOptions.onRateLimit } : {};
  const ambient = currentCredentialPool(name);
  if (ambient !== undefined) {
    // M93 — the THIRD arm. Found while writing the second one's test: the ambient pool also returned
    // the client without the decorator, and leaving it out would create the same asymmetry the milestone removes,
    // only on a less visible path.
    return new PoolAwareLlmClient(
      ambient,
      (apiKey) => selectTransport(profile, apiKey, perCallBaseUrl),
      undefined,
      resilience,
    );
  }
  const poolKeys = filterPoolKeys(routerOptions.apiKeys?.[name]);
  const noAuthOverride = maybeBuildNoAuthTransport(profile, poolKeys, perCallBaseUrl);
  if (noAuthOverride !== undefined) return noAuthOverride;
  return buildPoolOrSingle({ name, profile, poolKeys, routerOptions, perCallBaseUrl });
}

/** Resolves the transport and applies retry — the one place resilience is attached. */
function buildClient(
  name: string,
  routerOptions: ProviderRouterOptions,
  perCallBaseUrl?: string,
): LlmClient | undefined {
  const transport = buildTransport(name, routerOptions, perCallBaseUrl);
  return transport === undefined ? undefined : new RetryingLlmClient(transport);
}

/**
 * EC-C MUST FIX (ADR D187): `authType: "none"` providers ignore apiKeys.
 * Building a CredentialPool against a runtime without auth is semantically
 * meaningless; emit one-shot warn and route to the sentinel transport.
 */
function maybeBuildNoAuthTransport(
  profile: ProviderProfile,
  poolKeys: string[] | undefined,
  baseUrl?: string,
): LlmClient | undefined {
  if (profile.authType !== "none" || poolKeys === undefined || poolKeys.length === 0) {
    return undefined;
  }
  warnNoAuthApiKeysIgnoredOnce(profile.name);
  const sentinel = sentinelForNoAuth(profile);
  if (sentinel === undefined) return undefined;
  return selectTransport(profile, sentinel, baseUrl);
}

/** Pool path for ≥2 keys; single-key fast path otherwise; sentinel fallback. */
function buildPoolOrSingle(args: {
  name: string;
  profile: ProviderProfile;
  poolKeys: string[] | undefined;
  routerOptions: ProviderRouterOptions;
  /** `ModelSelection.url`, and ONLY for the provider the model id names — see `addClient`. */
  perCallBaseUrl: string | undefined;
}): LlmClient | undefined {
  const { name, profile, poolKeys, routerOptions, perCallBaseUrl } = args;
  if (poolKeys !== undefined && poolKeys.length >= 2) {
    const strategy = routerOptions.credentialPoolStrategy?.[name] ?? "fill_first";
    const entries = poolKeys.map((accessToken, priority) =>
      newPooledCredential({ provider: name, accessToken, priority, source: "manual" }),
    );
    const pool = new CredentialPool(name, entries, strategy);
    const resilience =
      routerOptions.onRateLimit !== undefined ? { onRateLimit: routerOptions.onRateLimit } : {};
    // M93 — the pool ALREADY had retry inside; the outer decorator covers what it propagates (5xx and
    // network, which `classifyAndDecide` tells it to propagate because "the pool does not help"). Additive: rotation
    // behavior does not change.
    return new PoolAwareLlmClient(
      pool,
      (apiKey) => selectTransport(profile, apiKey, perCallBaseUrl),
      undefined,
      resilience,
    );
  }
  // 1-entry pool / single-key fast path: prefer explicit apiKeys[name] over env.
  // D182: `authType: "none"` providers fall back to a sentinel placeholder
  // when no key is set — transports that ignore the Authorization header still work.
  // D286/D288: `aws_bearer` / `gcp_oauth` profiles use a lazy sentinel so the
  // client can resolve real credentials at stream time (helpful error if missing).
  const apiKey =
    poolKeys?.[0] ??
    resolveApiKey(profile.envVars) ??
    sentinelForNoAuth(profile) ??
    sentinelForLazyAuth(profile);
  if (apiKey === undefined) return undefined;
  // M93 — the ONE-key arm returned the RAW transport, with no retry at all. A pool of 1 key is a
  // pool of size 1: what changes between 1 and 2 keys is whether there is somewhere to rotate to, not
  // whether resilience exists. The typical consumer resolves exactly one credential and always landed here.
  return selectTransport(profile, apiKey, perCallBaseUrl);
}

/**
 * Base-URL override read from the environment, for the providers that document one.
 *
 * `ollama` is deliberately absent. It never reached this switch: `selectTransport` returns
 * `OllamaNativeClient` for it before the `chat_completions` body runs, so `OLLAMA_HOST` is read at
 * that earlier branch instead. The arm that used to sit here was unreachable and read like the
 * mechanism implementing `OLLAMA_HOST` — a decoy that cost a measurement pass (B-097).
 */
function resolveBaseUrlEnvOverride(providerName: string): string | undefined {
  switch (providerName) {
    case "openai":
      return process.env.OPENAI_API_BASE_URL;
    case "openrouter":
      return process.env.OPENROUTER_API_BASE_URL;
    case "lmstudio":
      return process.env.LMSTUDIO_HOST;
    case "llamacpp":
      return process.env.LLAMACPP_HOST;
    default:
      return undefined;
  }
}

// EC-C: one-shot warn keyed by provider name.
const warnedNoAuthApiKeys = new Set<string>();
function warnNoAuthApiKeysIgnoredOnce(provider: string): void {
  if (warnedNoAuthApiKeys.has(provider)) return;
  warnedNoAuthApiKeys.add(provider);
  diag(
    `[theokit-sdk] provider "${provider}" has authType: "none" — apiKeys ignored (no auth required for local runtime).\n`,
  );
}

/** Test-only reset. @internal */
export function _resetNoAuthApiKeyWarnings(): void {
  warnedNoAuthApiKeys.clear();
}

/**
 * D182: providers declaring `authType: "none"` use a placeholder credential
 * so the OpenAI-compat transport keeps working. The placeholder value is
 * never sensitive — local runtimes ignore the Authorization header.
 */
function sentinelForNoAuth(profile: ProviderProfile): string | undefined {
  return profile.authType === "none" ? profile.name : undefined;
}

/**
 * D286 / D288: providers with lazy-resolved auth (Bedrock Bearer via
 * `@aws/bedrock-token-generator`, Vertex via `google-auth-library`) may not
 * have credentials available at construction time — the client resolves
 * them per-request and throws helpful `ConfigurationError` if missing
 * (EC-1, EC-6 absorbed). Use a placeholder so the router still builds
 * the client; the user sees the helpful error on the first `agent.send`.
 */
function sentinelForLazyAuth(profile: ProviderProfile): string | undefined {
  if (profile.authType === "aws_bearer") return "__bedrock_lazy_token__";
  if (profile.authType === "gcp_oauth") return "__vertex_lazy_token__";
  // M42: an oauth provider carries no static key — build the client with a lazy placeholder so its M41
  // `transform.fetch(ctx)` (which calls `resolveCredential` to obtain a freshly-refreshed bearer) owns
  // the real Authorization at stream time. Plain (api_key/none) profiles are unaffected.
  if (profile.authType === "oauth_device_code" || profile.authType === "oauth_external") {
    return "__oauth_lazy_token__";
  }
  return undefined;
}

function filterPoolKeys(keys: string[] | undefined): string[] | undefined {
  if (keys === undefined) return undefined;
  const cleaned = keys.filter((k) => typeof k === "string" && k.length > 0);
  return cleaned.length === 0 ? undefined : cleaned;
}

const warnedProviders = new Set<string>();
function warnUnknownProvidersInApiKeys(apiKeys: Record<string, string[]> | undefined): void {
  if (apiKeys === undefined) return;
  for (const name of Object.keys(apiKeys)) {
    if (warnedProviders.has(name)) continue;
    const profile = getProviderProfile(name);
    if (profile === undefined) {
      warnedProviders.add(name);
      diag(
        `[theokit-sdk] credential-pool: unknown provider "${name}" in apiKeys (no profile registered)\n`,
      );
    }
  }
}

/** Test-only reset. @internal */
export function _resetCredentialPoolWarnings(): void {
  warnedProviders.clear();
}

/**
 * Test seam for {@link resolveApiKey}. NOT re-exported from any barrel — `_...ForTests` is this
 * repo's convention for reaching a private function from a test rather than copying it.
 *
 * It exists because the ordering this function implements had no test that could fail. The one named
 * for it set a single env var and asserted the chain had length 1, which proves the fallback is
 * consulted and would survive the profile's list being reversed. The only other place the choice is
 * observable is the Authorization header at stream time, and reaching it for a BUILTIN profile means
 * a real request — measured: the first attempt at that test sent one to openrouter and came back 401.
 *
 * @internal
 */
export function _resolveApiKeyForTests(envVars: ReadonlyArray<string>): string | undefined {
  return resolveApiKey(envVars);
}

/**
 * EC-10: resolve API key from ordered envVars list; first non-empty wins.
 */
function resolveApiKey(envVars: ReadonlyArray<string>): string | undefined {
  for (const v of envVars) {
    const value = process.env[v];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * EC-3 fix: exhaustive switch with actionable error on unsupported apiMode.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 4-mode transport ladder (chat_completions / anthropic_messages / responses_api / bedrock) + Ollama native dispatch (D191) + per-provider envOverride is one cohesive switch — splitting hurts readability and obscures the dispatch contract.
function selectTransport(
  profile: ProviderProfile,
  apiKey: string,
  /** #332 — the endpoint THIS call should reach; outranks the provider's base-URL env var. */
  baseUrl?: string,
): LlmClient {
  // M41 — the optional provider `transform` seam (refresh-aware `fetch` + dynamic `headers` from the resolved
  // bearer). Invoked LAZILY, per-branch, ONLY by the transports that consume it (chat_completions +
  // responses_api) — so a transform's side effects (e.g. a token refresh) never fire for a transport that
  // ignores it (bedrock / ollama). Absent ⇒ each branch takes its byte-for-byte static path.
  const applyTransform = (): { fetch?: typeof fetch; headers?: Record<string, string> } => {
    if (profile.transform === undefined) return {};
    const ctx = { apiKey };
    return { fetch: profile.transform.fetch?.(ctx), headers: profile.transform.headers?.(ctx) };
  };

  /**
   * Applies the provider's transform over `opts` and returns the constructed client.
   *
   * The `chat_completions` and `anthropic_messages` arms did this IDENTICALLY, differing only in the
   * final constructor. That is duplicated KNOWLEDGE: "apply the transform, require OAuth to be
   * resolved, and merge the dynamic headers ON TOP of the profile's static ones" is the same rule for
   * any provider — fixing it in one arm and forgetting the other would leave one provider with a
   * refresh-aware transport and the other without, silently.
   *
   * Generic over `O` because each arm declares its own `opts` with its constructor's type
   * (`ConstructorParameters<typeof OpenAIClient>[0]` vs Anthropic's) — that is why a
   * the first attempt with a non-generic helper, declared before the `if`s, did not compile.
   */
  const withTransform = <
    O extends { fetch?: typeof fetch; extraHeaders?: Record<string, string> },
    C,
  >(
    opts: O,
    construct: (o: O) => C,
  ): C => {
    const t = applyTransform();
    assertOAuthResolved(t);
    if (t.fetch !== undefined) opts.fetch = t.fetch;
    const merged =
      profile.extraHeaders !== undefined || t.headers !== undefined
        ? { ...profile.extraHeaders, ...t.headers }
        : undefined;
    if (merged !== undefined) opts.extraHeaders = merged;
    return construct(opts);
  };

  // M42 review MEDIUM-1 — the auth model: a provider's auth
  // resolves to real headers at request time or FAILS with `MissingCredentialError` — it NEVER puts a
  // placeholder on the wire. theokit builds an oauth provider's client with the `__oauth_lazy_token__`
  // placeholder (so the sync router can construct it), then the provider's `transform`
  // supplies the real bearer via fetch or an authorization header. If it supplies
  // neither, fail fast here with the MissingCredentialError analog instead of POSTing the placeholder upstream.
  const assertOAuthResolved = (t: {
    fetch?: typeof fetch;
    headers?: Record<string, string>;
  }): void => {
    if (apiKey !== "__oauth_lazy_token__") return;
    const auth = t.headers?.authorization ?? t.headers?.Authorization;
    if (t.fetch === undefined && auth === undefined) {
      throw new ConfigurationError(
        `provider "${profile.name}" uses OAuth (authType: ${profile.authType}) but no credential was ` +
          `resolved. Register a ProviderProfile.transform whose fetch (or headers.authorization) supplies ` +
          `the bearer — typically via resolveCredential() from "@theokit/sdk/auth".`,
      );
    }
  };

  if (profile.apiMode === "chat_completions") {
    // ADR D191 (T8.1 dogfood fix): Ollama tool calling REQUIRES the native
    // `/api/chat` endpoint. OpenAI-compat `/v1/chat/completions` causes
    // models to emit raw tool JSON as plain text — confirmed via peer-project
    // upstream warning and our own dogfood of telegram-pro.
    if (profile.name === "ollama") {
      const ollamaBase = baseUrl ?? process.env.OLLAMA_HOST ?? profile.baseUrl;
      return new OllamaNativeClient({ apiKey, baseUrl: ollamaBase });
    }
    const opts: ConstructorParameters<typeof OpenAIClient>[0] = { apiKey };
    opts.baseUrl = profile.baseUrl;
    // T1.1 (ADR D185): forward provider name so OpenAIClient can dispatch
    // Ollama-specific error mapping for ECONNREFUSED / 404-not-pulled / 503-loading.
    opts.providerName = profile.name;
    // theokit#58 follow-up: opt-in leaked-dialect safe-parse, declared per-profile (default off).
    if (profile.extractToolCallsFromContent === true) {
      opts.extractToolCallsFromContent = true;
    }
    // M45 — explicit chat-completions path override (data-only escape for unversioned shapes).
    if (profile.chatCompletionsPath !== undefined) {
      opts.chatCompletionsPath = profile.chatCompletionsPath;
    }
    if (profile.name === "openai" && process.env.OPENAI_ORGANIZATION !== undefined) {
      opts.organization = process.env.OPENAI_ORGANIZATION;
    }
    // Honor explicit base URL overrides for cloud providers + the local
    // `authType: "none"` family (D188, D189). All four `_HOST` /
    // `_API_BASE_URL` vars are intentionally separate so users can mix
    // remote-box pointing without disturbing the others. Ollama is NOT one of
    // them here — it returns above, and reads `OLLAMA_HOST` on that branch.
    const envOverride = resolveBaseUrlEnvOverride(profile.name);
    if (envOverride !== undefined) opts.baseUrl = envOverride;
    // #332 — last, so the model's own endpoint outranks the process-wide env var above.
    if (baseUrl !== undefined) opts.baseUrl = baseUrl;
    // M41 — feed the provider transform: `fetch` (refresh-aware transport) + `headers` merged over the
    // profile's static `extraHeaders`. OpenAIClient now honors `extraHeaders` (was ignored) — additive-safe:
    // no builtin sets it on chat_completions.
    return withTransform(opts, (o) => new OpenAIClient(o));
  }
  if (profile.apiMode === "anthropic_messages") {
    // Vertex sub-dispatch (D301): when profile.name === "vertex", route to
    // VertexRouterClient which picks Gemini vs Anthropic at stream time.
    // apiKey is either a real Bearer token (rare — caller passed it
    // explicitly) or the lazy sentinel `__vertex_lazy_token__` — strip
    // the latter so the client falls through to ADC discovery (D288).
    if (profile.name === "vertex") {
      const realKey = apiKey === "__vertex_lazy_token__" ? undefined : apiKey;
      return new VertexRouterClient(realKey !== undefined ? { apiKey: realKey } : {});
    }
    const opts: ConstructorParameters<typeof AnthropicClient>[0] = { apiKey };
    // `baseUrl` first, matching the chat_completions branch and the field's own contract:
    // `ModelSelection.url` is "the endpoint THIS call should reach" and outranks the process-wide
    // env var. It reached only `ollama` and `chat_completions`; here a run aimed at localhost went
    // to api.anthropic.com with the caller's key and said nothing (B-150).
    opts.baseUrl = baseUrl ?? process.env.ANTHROPIC_API_BASE_URL ?? profile.baseUrl;
    // M45 — feed the provider transform + static extraHeaders (mirror of the M41 chat_completions wiring),
    // so anthropic_messages providers can carry headers (anthropic-beta) and refresh-aware fetches (M46).
    return withTransform(opts, (o) => new AnthropicClient(o));
  }
  if (profile.apiMode === "bedrock_anthropic") {
    // D301: dedicated Bedrock InvokeModel client. apiKey from env when set;
    // strip the lazy sentinel so client triggers @aws/bedrock-token-generator (D287).
    const realKey = apiKey === "__bedrock_lazy_token__" ? undefined : apiKey;
    // `BedrockAnthropicClient` accepts `baseUrl` (bedrock-anthropic.ts:40) and the router never
    // passed it, so `model.url` was silently dropped on this branch too (B-150). Absent, the
    // client still derives the regional endpoint from the model id, as before.
    return new BedrockAnthropicClient({
      ...(realKey !== undefined ? { apiKey: realKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl: baseUrl } : {}),
    });
  }
  if (profile.apiMode === "responses_api") {
    // M40 — the OpenAI Responses-API transport (ChatGPT Codex backend + any responses provider). Consumes
    // `baseUrl` + `extraHeaders`. M41 — feeds the provider `transform`: `headers` merge over `extraHeaders`
    // (dynamic auth headers like a live `ChatGPT-Account-Id`), and `fetch` becomes the refresh-aware fetch
    // (closes the gap where `ResponsesApiClient` accepted a `fetch?` the router never passed).
    const t = applyTransform();
    assertOAuthResolved(t);
    const mergedHeaders =
      profile.extraHeaders !== undefined || t.headers !== undefined
        ? { ...profile.extraHeaders, ...t.headers }
        : undefined;
    return new ResponsesApiClient({
      apiKey,
      // Per-call URL first, same contract as every other branch (B-150).
      ...((baseUrl ?? profile.baseUrl) !== undefined
        ? { baseUrl: (baseUrl ?? profile.baseUrl) as string }
        : {}),
      ...(mergedHeaders !== undefined ? { extraHeaders: mergedHeaders } : {}),
      ...(t.fetch !== undefined ? { fetch: t.fetch } : {}),
      // usetheokit/theokit-sdk#383 — forwarded only when the profile declares it, so a provider that
      // has not been measured against `reasoning.context` keeps the request it had.
      ...(profile.encryptedReasoning === true ? { encryptedReasoning: true } : {}),
      providerName: profile.name,
    });
  }
  // The message used to say: "Install a third-party transport plugin
  // (@theokit-transport-${apiMode})". There is no plugin mechanism to install into —
  // `registerTransport` and `transportRegistry` have zero hits in this package, and the only other
  // occurrence of the string `theokit-transport` was a docblock describing this line. A reader would
  // have searched for the package, then for the plugin API, before concluding the SDK was wrong
  // rather than their configuration. Transports are a closed set; the message now says so and names
  // the whole set, which is a smaller promise and the true one.
  throw new ConfigurationError(
    `Provider "${profile.name}" declares apiMode "${profile.apiMode}", which this SDK has no ` +
      `transport for. Transports are built in and cannot be extended by a plugin; the supported ` +
      `modes are "chat_completions", "anthropic_messages", "bedrock_anthropic" and ` +
      `"responses_api". Change the provider's apiMode to one of those, or open an issue if the ` +
      `provider genuinely speaks a fifth protocol.`,
    { code: "transport_unavailable" },
  );
}
