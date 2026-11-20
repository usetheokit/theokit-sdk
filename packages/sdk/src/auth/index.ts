/**
 * `@theokit/sdk/auth` — the M42 auth subsystem: a hardened credential store (`api|oauth` discriminated
 * union, atomic O_EXCL + rename + fsync write at 0600, 0700/0600 mode gates) plus an OAuth engine (RFC 8628
 * device grant, OpenAI two-step headless flow, token exchange + transparent refresh with in-flight-refresh
 * coalescing). Generalized to `provider: string` + a caller-supplied `CredentialStoreConfig` — no hardcoded
 * client IDs. `resolveCredential(name)` returns a fresh (auto-refreshed) `ResolvedCredential`; an oauth
 * provider composes it into its `ProviderProfile.transform.fetch` so the router obtains the fresh bearer at
 * stream time.
 *
 * Exposed as a dedicated sub-entry (DTS built via tsc) — the same isolation the SDK uses for `messages` /
 * `subscription` / `sanitize`, because rollup-plugin-dts cannot bundle these modules into the main barrel.
 *
 * @packageDocumentation
 */

/**
 * "Which provider issued this key?" — the question a login flow asks before any profile exists.
 *
 * Made REACHABLE rather than written: the SDK already answered it, from a module no entry point
 * exported, and a measured consumer wrote its own copy because it could not import ours. The lookup
 * now derives its longest-first ordering instead of depending on the order the table happens to be
 * typed in.
 *
 * NOTE — do not name the internal-visibility tag in this docblock. `tsconfig.base.json` sets
 * `stripInternal: true`, and TypeScript matches the tag anywhere in an attached JSDoc, prose
 * included. Mentioning it here deleted this very line from `dist/auth/index.d.ts`: the symbol
 * shipped at runtime and could not be imported with types — the exact defect this export exists to
 * fix, reintroduced by the comment explaining the fix (usetheodev/theokit-sdk#283).
 */
export { providerFromApiKeyPrefix } from "../internal/auth/api-key-prefix.js";
// Credential store.
export {
  assertSecureModes,
  authFilePath,
  CredentialError,
  credentialHome,
  readAuthFile,
  readStoredOAuth,
  writeCredential,
} from "../internal/auth/credential-store.js";
// OAuth device-authorization flows (RFC 8628 + OpenAI two-step) + JWT helpers.
export {
  deviceLogin,
  extractAccountId,
  openaiDeviceLogin,
  parseJwtClaims,
  pollDeviceToken,
  requestDeviceCode,
  requestOpenAIUsercode,
} from "../internal/auth/oauth-device.js";
// OAuth engine — exchange / refresh / persist / transparent-refresh.
export {
  ensureFreshCredential,
  exchangeCode,
  persistOAuthTokens,
  refreshOAuthTokens,
} from "../internal/auth/oauth-engine.js";
// The public composition entrypoint.
export {
  type ResolveCredentialOptions,
  resolveCredential,
} from "../internal/auth/resolve-credential.js";
// One documented answer to "which provider and which key?".
export {
  type CredentialOrigin,
  DEFAULT_PROVIDER_CANDIDATES,
  type ProviderCandidate,
  ProviderCredentialError,
  type ResolvedProviderCredential,
  type ResolveProviderCredentialInput,
  resolveProviderCredential,
} from "../internal/auth/resolve-provider-credential.js";
// Contract types (leaf module — single canonical origin).
export type {
  CredentialStoreConfig,
  DeviceCodeGrant,
  DeviceDeps,
  DeviceOAuthConfig,
  HttpDeps,
  OAuthProviderConfig,
  OAuthTokens,
  OpenAIDeviceConfig,
  ResolvedCredential,
  StoredApiCredential,
  StoredCredential,
  StoredOAuthCredential,
} from "../internal/auth/types.js";
