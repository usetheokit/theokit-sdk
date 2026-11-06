/**
 * M42 — shared auth contract types. A LEAF module: pure type declarations, NO runtime imports (no zod, no
 * node:fs). Every auth module (`credential-store`, `oauth-engine`, `oauth-device`, `resolve-credential`)
 * imports its cross-module types from here so the barrel's rollup-plugin-dts bundle sees a single canonical
 * origin — the codebase's established "leaf-type-only deps" pattern (see tsup.config.ts), which sidesteps
 * the rollup-dts cross-module resolution limitation that a value-module type export trips.
 *
 * Every type here is re-exported from `@theokit/sdk/auth` and is therefore PUBLIC, under semver.
 *
 * This block sits directly above `CredentialStoreConfig` with no statement between them, so it is
 * one of that declaration's leading comment ranges — an internal-visibility tag written here is
 * scanned by `stripInternal` and deletes the interface from the emitted `.d.ts`. That is exactly
 * what happened, and it is the same trap recorded in `src/auth/index.ts`
 * (usetheodev/theokit-sdk#283). Do not name that tag anywhere in this file.
 *
 * @packageDocumentation
 */

/**
 * Where the credential store lives — the three path segments, plus an optional environment
 * override.
 *
 * The store directory is `join(home, dirName)` and the file is `fileName` inside it. When
 * `homeEnvVar` is set AND the caller's `env` map holds that variable non-blank, its trimmed value
 * REPLACES the whole directory: `dirName` is not appended to it, mirroring how `CODEX_HOME` works.
 * A blank or absent variable falls back to `join(home, dirName)`.
 *
 * `env` is always a parameter on the functions that take this config, never an ambient
 * `process.env` read, and it defaults to an empty map — so a caller that forgets to pass it gets
 * the non-overridden path rather than whatever the process happens to have.
 *
 * Nothing here is validated or created. A relative `home` stays relative to the process cwd, and
 * the directory is created on first write, at mode 0700.
 *
 * The store this addresses holds live credentials in plaintext, so `dirName` should be a directory
 * the SDK owns rather than one shared with unrelated state: reads enforce 0700 on the directory
 * and 0600 on the file, and refuse when either is looser.
 */
export interface CredentialStoreConfig {
  /** Base home directory (e.g. `os.homedir()`). */
  home: string;
  /** The store subdirectory under `home` (e.g. `.agent-builder`, `.codex`). */
  dirName: string;
  /** The credential file name inside the store dir (e.g. `auth.json`). */
  fileName: string;
  /** Optional env var name that, when set + non-blank, overrides the full store dir. */
  homeEnvVar?: string;
}

/**
 * The flat bearer surface every consumer holds. `kind:'api'` is the classic API-key path; `kind:'oauth'` is
 * an OAuth session whose `apiKey` is the CURRENT access token, so consumers keep passing a flat bearer
 * string unchanged. `provider` is an open string (any registered provider name).
 */
export interface ResolvedCredential {
  kind: "api" | "oauth";
  provider: string;
  /** The effective BEARER the transport sends — an API key, or (oauth) the current access token. */
  apiKey: string;
  /** Where it came from — an env var NAME or a file path. Never the value. */
  source: string;
  /** True when the provider was derived rather than declared. */
  inferred: boolean;
  /** oauth only: epoch ms the access token expires. Drives the refresh in the oauth engine. */
  expiresAt?: number;
}

/**
 * The API-key variant of the credential file, as it sits on disk.
 *
 * `api_key` is the key in PLAINTEXT. Nothing in this SDK encrypts, hashes or otherwise obscures
 * it; the protection is filesystem permissions alone — `writeCredential` persists the file at
 * mode 0600 inside a 0700 directory, and `readAuthFile` refuses to read a file readable by other
 * users or a directory writable by them. On Windows that gate is skipped entirely, because the
 * mode bits Node reports there do not describe the real ACLs.
 *
 * `type` and `provider` are both optional so that a legacy file written before the union existed
 * — a bare `{ "provider": ..., "api_key": ... }` — still parses as this variant with no
 * migration. `type` is never written: the api variant is persisted without the discriminant, and
 * absence of `type` is what identifies it on the next read.
 *
 * The file schema is strict, so an unknown key makes the whole file fail to parse with a
 * `CredentialError` naming the offending path.
 */
export interface StoredApiCredential {
  type?: "api";
  provider?: string;
  api_key: string;
}

/**
 * The OAuth variant of the credential file, as it sits on disk.
 *
 * `access` and `refresh` are both stored in PLAINTEXT, under the same 0600 file / 0700 directory
 * gate as the API-key variant and with no additional protection. The refresh token is the more
 * durable of the two — an expired `access` is worth little, a leaked `refresh` mints new ones —
 * and it is why `readStoredOAuth` is the only path that hands this shape out: the resolved
 * credential every other consumer sees carries the access token and nothing else.
 *
 * `type: "oauth"` is the discriminant and is always written; a file without it reads back as the
 * API-key variant. `provider`, `access` and `refresh` must be non-empty — `writeCredential`
 * refuses an empty access or refresh token, and the read schema rejects empty strings.
 *
 * `expires` is epoch milliseconds for the ACCESS token only. Nothing here records when the
 * refresh token expires, so a refresh failing because the grant itself lapsed is only observable
 * at the token endpoint.
 */
export interface StoredOAuthCredential {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  /** Epoch ms the access token expires. */
  expires: number;
  account_id?: string;
  /** The provider's OpenID ID token, when its token endpoint returned one (#821). */
  id_token?: string;
}

/**
 * Whatever the credential file turned out to hold — the two variants are discriminated by `type`.
 *
 * Narrow with `stored.type === "oauth"`, not by probing for a field. The API-key variant leaves
 * `type` undefined rather than setting it to `"api"`, so `type !== "oauth"` is the reliable test
 * for the API-key side and `type === "api"` misses every legacy file.
 *
 * Reading a file is what produces this value, and both variants carry a live secret in plaintext.
 * Treat it as one: it should not be logged, serialized into telemetry, or put in an error message.
 */
export type StoredCredential = StoredApiCredential | StoredOAuthCredential;

/** A provider's OAuth endpoints + client identity. Passed in (provider-agnostic). */
export interface OAuthProviderConfig {
  provider: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
}

/** The token triple persisted to the store's oauth variant. */
export interface OAuthTokens {
  access: string;
  refresh: string;
  /** Epoch ms the access token expires. */
  expires: number;
  accountId?: string;
  /** The OpenID ID token, when the token endpoint returned one (#821). */
  idToken?: string;
}

/** Injected HTTP + clock effects — deterministic in tests, real in production. */
export interface HttpDeps {
  fetch: typeof fetch;
  now: () => number;
}

/** A device-grant config: the OAuth config plus the RFC 8628 device authorization endpoint. */
export interface DeviceOAuthConfig extends OAuthProviderConfig {
  /** RFC 8628 device authorization endpoint — returns device_code + user_code + verification_uri. */
  deviceCodeEndpoint: string;
}

/** The device authorization the user acts on. Times/interval are SECONDS (RFC 8628). */
export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between token polls (server-mandated minimum). */
  interval: number;
  /** Seconds until the device_code expires. */
  expiresIn: number;
}

/** Injected effects for the device flow — deterministic in tests, real in production. */
export interface DeviceDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** The OpenAI two-step device config: usercode + poll endpoints return an authorization_code (not tokens). */
export interface OpenAIDeviceConfig extends OAuthProviderConfig {
  /** POST `{client_id}` here → `{device_auth_id, user_code, interval}`. */
  deviceUsercodeEndpoint: string;
  /** Poll `{device_auth_id, user_code}` here → 200 `{authorization_code, code_verifier}`; 403/404 = pending. */
  devicePollEndpoint: string;
  /** Verification URL the user opens to enter the code. */
  verificationUri: string;
}
