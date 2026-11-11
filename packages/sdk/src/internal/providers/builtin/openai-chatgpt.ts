/**
 * M43 — the ChatGPT "Codex" backend as a first-class builtin `ProviderProfile`. Migrated from the
 * agent-builder M40 workaround; the SDK now owns the provider, so a consumer only selects
 * `openai-chatgpt/<model>` and logs in — ZERO provider logic in the consumer.
 *
 * The provider-auth model (see the codex-provider-in-sdk blueprint):
 * - static profile + a `transform.fetch` that resolves the LIVE credential per HTTP request (fresh Bearer +
 *   dynamic `ChatGPT-Account-Id`), so a mid-turn expiry refreshes transparently with NO agent rebuild;
 * - the protocol values (endpoint, models, oauth config, `originator` header) are SDK-owned constants.
 *
 * @internal
 */

import { homedir } from "node:os";

import { AuthenticationError } from "../../../errors.js";
import { readStoredOAuth } from "../../auth/credential-store.js";
import { resolveCredential } from "../../auth/resolve-credential.js";
import type { CredentialStoreConfig, OAuthProviderConfig } from "../../auth/types.js";
import type { ProviderProfile } from "../types.js";

/**
 * The SDK-owned ambient credential store the transform reads. Defaults to `~/.theokit/auth.json`. A consumer
 * points it at its existing store dir via the DEDICATED `THEOKIT_AUTH_HOME` env var (NOT `THEOKIT_HOME` — that
 * is the SDK's whole home directory for personality/credential-pool/profiles; overloading it would redirect
 * the entire runtime). The SDK's ambient credential service.
 */
const DEFAULT_STORE: CredentialStoreConfig = {
  home: homedir(),
  dirName: ".theokit",
  fileName: "auth.json",
  homeEnvVar: "THEOKIT_AUTH_HOME",
};

/**
 * The OpenAI OAuth config the transform resolves + refreshes against. `provider: "openai"` is the STORE
 * provider (what `/login` persists), deliberately distinct from this profile's routing name `openai-chatgpt`
 * — the two-namespace split separates the integration id from the routed provider. Endpoints/clientId/scopes
 * are OpenAI's published OAuth values.
 */
const OPENAI_OAUTH_CONFIG: OAuthProviderConfig = {
  provider: "openai",
  authorizeEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  redirectUri: "https://auth.openai.com/deviceauth/callback",
};

/**
 * Build the per-request fetch: resolve a FRESH (refreshed) Bearer + the LIVE account-id from the ambient
 * store, and inject them as headers. Re-resolves on EVERY call → mid-turn refresh with no rebuild. A
 * `Headers` object is used so `authorization` is set case-insensitively (never doubled). If no credential is
 * logged in, throw a clear error rather than putting the router's `__oauth_lazy_token__` placeholder on the
 * wire (fail-closed — missing-credential semantics).
 */
export function codexFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const env = process.env as Record<string, string | undefined>;
    const resolved = await resolveCredential({
      provider: "openai",
      store: DEFAULT_STORE,
      oauth: OPENAI_OAUTH_CONFIG,
      env,
    });
    if (resolved === undefined) {
      // AuthenticationError, not a bare Error. `isTransientError` is
      // `err instanceof TheokitAgentError && err.isRetryable`, so a bare Error here is permanently
      // non-retryable AND invisible to a consumer branching on `instanceof AuthenticationError` —
      // which is what a caller does when a login has expired. router.ts:378 already throws typed for
      // the same missing-OAuth-credential condition.
      throw new AuthenticationError(
        'openai-chatgpt: no ChatGPT credential found — run the OpenAI device login (e.g. "/login openai") first.',
        { code: "missing_credential" },
      );
    }
    const accountId = readStoredOAuth(DEFAULT_STORE, env)?.account_id;
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${resolved.apiKey}`);
    if (accountId !== undefined) headers.set("ChatGPT-Account-Id", accountId);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

export const OPENAI_CHATGPT: ProviderProfile = {
  name: "openai-chatgpt",
  apiMode: "responses_api",
  authType: "oauth_device_code",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  envVars: [],
  fallbackModels: [
    "openai-chatgpt/gpt-5.4",
    "openai-chatgpt/gpt-5.4-mini",
    "openai-chatgpt/gpt-5.5",
  ],
  // #165 — this shipped as `codex_cli_rs`, another vendor's client identifier. Claiming to be a different
  // vendor's client is a false statement of identity. Third-party clients send their OWN name against
  // this same endpoint, which also shows the route is not restricted to the official client.
  extraHeaders: { originator: "theokit" },
  // usetheokit/theokit-sdk#383 — carry the model's encrypted reasoning between the rounds of a turn.
  // On for THIS profile and no other because this is the endpoint the issue measured: OpenAI Codex
  // sends `include: ["reasoning.encrypted_content"]` with `reasoning.context: "all_turns"` to the
  // same backend, same model, on the same account, so acceptance is observed rather than assumed.
  // The issue's measurement — a third of our bytes, 2.8x our tokens — is what this closes together
  // with `prompt_cache_key`.
  encryptedReasoning: true,
  transform: {
    // Only `fetch` (async) can await the credential refresh; `headers` is sync and cannot.
    fetch: () => codexFetch(),
  },
};
