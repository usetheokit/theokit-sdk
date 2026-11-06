/**
 * M42 — the SDK OAuth device-authorization flows (RFC 8628 + OpenAI two-step headless). Split out of
 * oauth-engine.ts to respect the 500-line file budget; a sibling of the core engine. Promoted DOWN from
 * agent-builder's hardened `agents/lib/oauth-device.ts` (M37).
 *
 * Implements two device flows against their published specs: the RFC 8628 device-grant poll loop
 * (device_code → authorization_pending / slow_down) and OpenAI's two-step headless flow, including the
 * JWT-claim / account-id extraction used to attribute an account.
 * Design choices: network I/O + clock + sleep are INJECTED (deterministic tests), failures raise the SDK's
 * typed `AuthCallbackError`, and a device-code expiry DEADLINE guards each poll loop.
 *
 * @internal
 */
import { AuthCallbackError } from "../../server/auth/errors.js";
import { exchangeCode } from "./oauth-engine.js";
import type {
  DeviceCodeGrant,
  DeviceDeps,
  DeviceOAuthConfig,
  OAuthTokens,
  OpenAIDeviceConfig,
} from "./types.js";

// ─── OAuth 2.0 Device Authorization Grant (RFC 8628) — terminal-first / headless login ───

/** Buffer added to every poll interval to avoid hitting the server a hair early. */
const POLLING_SAFETY_MARGIN_MS = 3000;

/**
 * Parse a JSON body, or fail with this module's typed error instead of a raw `SyntaxError`.
 *
 * Every failure in this file is supposed to reach the caller as an `AuthCallbackError` carrying a code
 * the CLI can branch on. `res.json()` breaks that contract: a device endpoint that answers with HTML —
 * a captive portal, a corporate proxy's sign-in page, a load balancer's error page — makes it reject
 * with a `SyntaxError` that no `catch` here handles, so it escapes untyped past a caller prepared only
 * for `AuthCallbackError`.
 *
 * The body is quoted, truncated, because "not JSON" and "not JSON, and it looks like a proxy login
 * page" are different diagnoses for whoever is holding the terminal — and routing them to the provider
 * when the fault is their network is the expensive kind of wrong.
 */
async function parseJsonOrFail(res: Response, code: string, what: string): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthCallbackError(code, `${what} returned a non-JSON body: ${text.slice(0, 120)}`);
  }
}

/** Step 1 — request a device code. POSTs `{client_id, scope}` to the device endpoint. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: RFC 8628 device-code request — cohesive network response parser ported verbatim (ADR D3).
export async function requestDeviceCode(
  config: DeviceOAuthConfig,
  deps: Pick<DeviceDeps, "fetch">,
): Promise<DeviceCodeGrant> {
  let res: Response;
  try {
    res = await deps.fetch(config.deviceCodeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: config.scopes.join(" "),
      }).toString(),
    });
  } catch (err) {
    throw new AuthCallbackError(
      "oauth_device_authorization_failed",
      `device request failed: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new AuthCallbackError(
      "oauth_device_authorization_failed",
      `device endpoint returned HTTP ${res.status}`,
    );
  }
  const data = (await parseJsonOrFail(
    res,
    "oauth_device_authorization_failed",
    "device endpoint",
  )) as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    verification_uri_complete?: unknown;
    interval?: unknown;
    expires_in?: unknown;
  };
  if (typeof data.device_code !== "string" || typeof data.user_code !== "string") {
    throw new AuthCallbackError(
      "oauth_device_authorization_failed",
      "device response missing device_code/user_code",
    );
  }
  const verification =
    typeof data.verification_uri === "string"
      ? data.verification_uri
      : typeof data.verification_uri_complete === "string"
        ? data.verification_uri_complete
        : "";
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: verification,
    interval: typeof data.interval === "number" && data.interval > 0 ? data.interval : 5,
    expiresIn: typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 900,
  };
}

/**
 * Step 2 — poll the token endpoint until the user approves (or the code expires). Handles RFC 8628
 * `authorization_pending` (keep waiting) and `slow_down` (back off), with an expiry deadline so it cannot
 * spin forever.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: RFC 8628 poll state machine (authorization_pending / slow_down / success / expiry) — a cohesive loop ported verbatim (ADR D3); fragmenting it would obscure the protocol.
export async function pollDeviceToken(
  config: DeviceOAuthConfig,
  grant: DeviceCodeGrant,
  deps: DeviceDeps,
): Promise<OAuthTokens> {
  const deadline = deps.now() + grant.expiresIn * 1000;
  let intervalMs = grant.interval * 1000;

  while (deps.now() < deadline) {
    let res: Response;
    try {
      res = await deps.fetch(config.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          device_code: grant.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      });
    } catch (err) {
      throw new AuthCallbackError(
        "oauth_token_exchange_failed",
        `device token poll failed: ${(err as Error).message}`,
      );
    }
    // RFC 8628 §3.5: `authorization_pending` / `slow_down` arrive as a 400 with an `error` body — so the
    // body MUST be read before deciding failure. Parse first; only a non-OAuth-shaped body on a non-2xx fails.
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
      error?: string;
      interval?: number;
    };
    if (!res.ok && typeof data.error !== "string") {
      throw new AuthCallbackError(
        "oauth_token_exchange_failed",
        `device token endpoint returned HTTP ${res.status}`,
      );
    }

    if (typeof data.access_token === "string" && data.access_token.length > 0) {
      const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
      const accountId = extractAccountId({
        access_token: data.access_token,
        id_token: data.id_token,
      });
      return {
        access: data.access_token,
        // Some device-grant providers (e.g. GitHub) issue no separate refresh token — reuse the access
        // token as the refresh handle.
        refresh: data.refresh_token ?? data.access_token,
        expires: deps.now() + expiresIn * 1000,
        ...(accountId !== undefined ? { accountId } : {}),
        ...(typeof data.id_token === "string" && data.id_token.length > 0
          ? { idToken: data.id_token }
          : {}),
      };
    }

    if (data.error === "authorization_pending") {
      await deps.sleep(intervalMs + POLLING_SAFETY_MARGIN_MS);
      continue;
    }
    if (data.error === "slow_down") {
      // RFC 8628 §3.5: add 5s to the interval, or honor a server-provided one.
      intervalMs =
        (typeof data.interval === "number" && data.interval > 0
          ? data.interval
          : grant.interval + 5) * 1000;
      await deps.sleep(intervalMs + POLLING_SAFETY_MARGIN_MS);
      continue;
    }
    if (typeof data.error === "string") {
      throw new AuthCallbackError(
        "oauth_token_exchange_failed",
        `device authorization rejected: ${data.error}`,
      );
    }
    await deps.sleep(intervalMs + POLLING_SAFETY_MARGIN_MS);
  }
  throw new AuthCallbackError(
    "oauth_device_code_expired",
    "the device code expired before it was approved",
  );
}

/**
 * The full device login: request a code, hand the user the verification URL + user code via `onPrompt`
 * (never printed here — the caller renders it, keeping this module output-free), then poll to completion.
 */
export async function deviceLogin(
  config: DeviceOAuthConfig,
  deps: DeviceDeps,
  hooks: {
    onPrompt: (p: { userCode: string; verificationUri: string; expiresIn: number }) => void;
  },
): Promise<OAuthTokens> {
  const grant = await requestDeviceCode(config, deps);
  hooks.onPrompt({
    userCode: grant.userCode,
    verificationUri: grant.verificationUri,
    expiresIn: grant.expiresIn,
  });
  return pollDeviceToken(config, grant, deps);
}

// ─── OpenAI / ChatGPT "headless" device flow (two-step) ───

/** Step 1 (OpenAI) — request the user code. */
export async function requestOpenAIUsercode(
  config: OpenAIDeviceConfig,
  deps: Pick<DeviceDeps, "fetch">,
): Promise<{ deviceAuthId: string; userCode: string; interval: number }> {
  let res: Response;
  try {
    res = await deps.fetch(config.deviceUsercodeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: config.clientId }),
    });
  } catch (err) {
    throw new AuthCallbackError(
      "oauth_device_authorization_failed",
      `usercode request failed: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new AuthCallbackError(
      "oauth_device_authorization_failed",
      `usercode endpoint returned HTTP ${res.status}`,
    );
  }
  const data = (await parseJsonOrFail(
    res,
    "oauth_device_authorization_failed",
    "usercode endpoint",
  )) as {
    device_auth_id?: unknown;
    user_code?: unknown;
    interval?: unknown;
  };
  if (typeof data.device_auth_id !== "string" || typeof data.user_code !== "string") {
    throw new AuthCallbackError(
      "oauth_device_authorization_failed",
      "usercode response missing device_auth_id/user_code",
    );
  }
  const interval = Math.max(
    typeof data.interval === "string" ? parseInt(data.interval, 10) || 5 : 5,
    1,
  );
  return { deviceAuthId: data.device_auth_id, userCode: data.user_code, interval };
}

/**
 * Step 2+3 (OpenAI) — poll for the authorization code (200 = ready; 403/404 = pending; else fail), then
 * exchange it for tokens at the standard `/oauth/token` endpoint (reuses `exchangeCode`).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: OpenAI two-step headless poll loop (200 ready / 403,404 pending / else fail) — cohesive network state machine ported verbatim (ADR D3).
export async function openaiDeviceLogin(
  config: OpenAIDeviceConfig,
  deps: DeviceDeps,
  hooks: { onPrompt: (p: { userCode: string; verificationUri: string }) => void },
): Promise<OAuthTokens> {
  const { deviceAuthId, userCode, interval } = await requestOpenAIUsercode(config, deps);
  hooks.onPrompt({ userCode, verificationUri: config.verificationUri });

  const intervalMs = interval * 1000;
  // Bound the loop so it cannot spin forever if the provider never resolves (upstream loops unbounded).
  const deadline = deps.now() + 15 * 60 * 1000;
  while (deps.now() < deadline) {
    let res: Response;
    try {
      res = await deps.fetch(config.devicePollEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      });
    } catch (err) {
      throw new AuthCallbackError(
        "oauth_token_exchange_failed",
        `device poll failed: ${(err as Error).message}`,
      );
    }
    if (res.ok) {
      const data = (await parseJsonOrFail(res, "oauth_token_exchange_failed", "device poll")) as {
        authorization_code?: unknown;
        code_verifier?: unknown;
      };
      if (typeof data.authorization_code !== "string" || typeof data.code_verifier !== "string") {
        throw new AuthCallbackError(
          "oauth_token_exchange_failed",
          "device poll returned no authorization_code",
        );
      }
      const tokens = await exchangeCode(
        config,
        { code: data.authorization_code, verifier: data.code_verifier },
        deps,
      );
      // M43 D4 fix #2 — the two-step exchange returns a JWT access token but `parseTokenResponse` only reads a
      // top-level `account_id`. JWT-extract the `chatgpt_account_id` (as the generic device poll already does)
      // so the login persists a non-empty account_id for the Codex `ChatGPT-Account-Id` header.
      return {
        ...tokens,
        accountId: tokens.accountId ?? extractAccountId({ access_token: tokens.access }),
      };
    }
    // 403/404 = still pending (user has not approved yet); anything else is a hard failure.
    if (res.status !== 403 && res.status !== 404) {
      throw new AuthCallbackError(
        "oauth_token_exchange_failed",
        `device poll returned HTTP ${res.status}`,
      );
    }
    await deps.sleep(intervalMs + POLLING_SAFETY_MARGIN_MS);
  }
  throw new AuthCallbackError(
    "oauth_device_code_expired",
    "the device authorization expired before approval",
  );
}

/** JWT id/access-token claims we read to attribute an account. */
interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
}

/** Decode a JWT's claim set (no signature verification — used only to read a self-reported account id). */
export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1] as string, "base64url").toString()) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

/** Best-effort account id from an id/access token's claims (OpenAI/ChatGPT shape). */
export function extractAccountId(tokens: {
  id_token?: string;
  access_token?: string;
}): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (token === undefined) continue;
    const claims = parseJwtClaims(token);
    const id =
      claims?.chatgpt_account_id ??
      claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims?.organizations?.[0]?.id;
    if (id !== undefined) return id;
  }
  return undefined;
}
