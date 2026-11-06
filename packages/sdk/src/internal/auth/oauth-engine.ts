/**
 * M42 — the SDK OAuth engine. Promoted DOWN from agent-builder's hardened `agents/lib/oauth.ts` +
 * `oauth-device.ts` (M37), generalized to `provider: string` + a caller-supplied {@link CredentialStoreConfig}
 * (no hardcoded client IDs — the caller declares its provider's endpoints). Ported VERBATIM (ADR D3): the
 * refresh coalescing lock, the no-token-in-error discipline, and the RFC 8628 device grant.
 *
 * Reuses the SDK's typed error taxonomy (`AuthCallbackError` from `server/auth`) for exchange/refresh
 * failures. All network I/O + clock + sleep are INJECTED so the flow is deterministic.
 *
 * The device flows follow their published specs: the RFC 8628 device grant (device_code →
 * authorization_pending / slow_down) and OpenAI's two-step headless flow with JWT-claim account attribution.
 *
 * @internal
 */
import { AuthCallbackError } from "../../server/auth/errors.js";
import { authFilePath, readStoredOAuth, writeCredential } from "./credential-store.js";
import type {
  CredentialStoreConfig,
  HttpDeps,
  OAuthProviderConfig,
  OAuthTokens,
  ResolvedCredential,
} from "./types.js";

/** Refresh a token this many ms BEFORE it actually expires (avoid a last-second, mid-request expiry). */
const REFRESH_SKEW_MS = 60_000;

/** Parse an OAuth token endpoint response into our token triple. Throws a typed error on a bad shape. */
function parseTokenResponse(body: unknown, now: number): OAuthTokens {
  const b = body as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    account_id?: unknown;
    id_token?: unknown;
  };
  if (typeof b.access_token !== "string" || b.access_token.length === 0) {
    throw new AuthCallbackError(
      "oauth_token_exchange_failed",
      "token response had no access_token",
    );
  }
  if (typeof b.refresh_token !== "string" || b.refresh_token.length === 0) {
    throw new AuthCallbackError(
      "oauth_token_exchange_failed",
      "token response had no refresh_token",
    );
  }
  const expiresIn = typeof b.expires_in === "number" ? b.expires_in : 3600;
  return {
    access: b.access_token,
    refresh: b.refresh_token,
    expires: now + expiresIn * 1000,
    ...(typeof b.account_id === "string" ? { accountId: b.account_id } : {}),
    ...(typeof b.id_token === "string" && b.id_token.length > 0 ? { idToken: b.id_token } : {}),
  };
}

/** POST a form-encoded grant to the token endpoint; return the parsed JSON or throw a typed error. */
async function postGrant(
  config: OAuthProviderConfig,
  form: Record<string, string>,
  deps: HttpDeps,
): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await deps.fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new AuthCallbackError(
      "oauth_token_exchange_failed",
      `token endpoint request failed: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    // The body may carry an OAuth `error` code, but never echo it verbatim — it can contain a token in
    // some providers' error payloads. Report the status only.
    throw new AuthCallbackError(
      "oauth_token_exchange_failed",
      `token endpoint returned HTTP ${res.status}`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // Do NOT echo the parser message — on a 200 non-JSON body it embeds a snippet of the response, which
    // in a token context can contain access/refresh material.
    throw new AuthCallbackError("oauth_token_exchange_failed", "token response was not valid JSON");
  }
  return parseTokenResponse(json, deps.now());
}

/** Exchange an authorization `code` (+ PKCE verifier) for the token pair. */
export function exchangeCode(
  config: OAuthProviderConfig,
  input: { code: string; verifier: string },
  deps: HttpDeps,
): Promise<OAuthTokens> {
  return postGrant(
    config,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: input.verifier,
    },
    deps,
  );
}

/** Swap a refresh token for a fresh access (and possibly rotated refresh) token. */
export function refreshOAuthTokens(
  config: OAuthProviderConfig,
  refresh: string,
  deps: HttpDeps,
): Promise<OAuthTokens> {
  return postGrant(
    config,
    { grant_type: "refresh_token", refresh_token: refresh, client_id: config.clientId },
    deps,
  );
}

/** Persist a token triple to the store's oauth variant through the hardened 0600 writer. */
export function persistOAuthTokens(
  provider: string,
  tokens: OAuthTokens,
  store: CredentialStoreConfig,
  env: Record<string, string | undefined> = {},
): string {
  return writeCredential(
    {
      type: "oauth",
      provider,
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      ...(tokens.accountId !== undefined ? { account_id: tokens.accountId } : {}),
      ...(tokens.idToken !== undefined ? { id_token: tokens.idToken } : {}),
    },
    store,
    env,
  );
}

/**
 * In-flight refreshes, keyed by the auth-file path. Refresh tokens ROTATE (single-use) on many providers,
 * so two concurrent turns must NOT both POST the same refresh token — the second would present an
 * already-consumed token and fail. This coalesces concurrent refreshes of the same store onto one promise.
 * Process-local — the single-credential store is per-user; a cross-process lock would be over-engineering.
 */
const inFlightRefresh = new Map<string, Promise<OAuthTokens>>();

/**
 * Return a credential guaranteed fresh enough to use. An `api` credential passes through untouched. An
 * `oauth` credential still valid (beyond the skew window) passes through; an expired one is refreshed,
 * re-persisted 0600, and returned with the new access token. Concurrent refreshes of the same store are
 * coalesced (single-use refresh tokens); the rejected promise is evicted so a failure is not cached-poison.
 */
export async function ensureFreshCredential(
  resolved: ResolvedCredential,
  opts: {
    config: OAuthProviderConfig;
    store: CredentialStoreConfig;
    env?: Record<string, string | undefined>;
  },
  deps: HttpDeps,
): Promise<ResolvedCredential> {
  if (resolved.kind !== "oauth") return resolved;

  const now = deps.now();
  if (resolved.expiresAt !== undefined && resolved.expiresAt > now + REFRESH_SKEW_MS) {
    return resolved; // still valid — no network, no rewrite
  }

  const env = opts.env ?? {};
  const path = authFilePath(opts.store, env);
  let refresh = inFlightRefresh.get(path);
  if (refresh === undefined) {
    refresh = (async (): Promise<OAuthTokens> => {
      const stored = readStoredOAuth(opts.store, env);
      if (stored === undefined) {
        // The resolved credential said oauth but the store no longer holds it — do not fabricate; surface it.
        throw new AuthCallbackError(
          "oauth_token_exchange_failed",
          "no stored oauth credential to refresh",
        );
      }
      const fresh = await refreshOAuthTokens(opts.config, stored.refresh, deps);
      // M43 D4 fix #1 — the OAuth refresh response returns JWTs, not a top-level `account_id`, so
      // `parseTokenResponse` leaves `fresh.accountId` undefined. Prefer a freshly-derived id, else PRESERVE
      // the stored one (account_id is stable) — otherwise the Codex `ChatGPT-Account-Id` header empties after
      // the first refresh and the backend 401/403s.
      // The refresh response may carry no ID token; keep the stored one rather than lose it (#821).
      const idToken = fresh.idToken ?? stored.id_token;
      const merged: OAuthTokens = {
        ...fresh,
        accountId: fresh.accountId ?? stored.account_id,
        ...(idToken !== undefined ? { idToken } : {}),
      };
      persistOAuthTokens(resolved.provider, merged, opts.store, env);
      return merged;
    })();
    inFlightRefresh.set(path, refresh);
    refresh.finally(() => inFlightRefresh.delete(path)).catch(() => {});
  }

  const fresh = await refresh;
  return {
    kind: "oauth",
    provider: resolved.provider,
    apiKey: fresh.access,
    source: resolved.source,
    inferred: false,
    expiresAt: fresh.expires,
  };
}
