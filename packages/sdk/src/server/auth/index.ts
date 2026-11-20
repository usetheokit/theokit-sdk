/**
 * Public barrel — `@theokit/sdk/server/auth`.
 *
 * Per ADR D6 (sub-path export) — consumers import via `@theokit/sdk/server/auth`
 * NOT main `@theokit/sdk` barrel. Tree-shaking + allows breaking changes in
 * auth surface without affecting Agent runtime consumers.
 *
 * T1.1 shipped types-only.
 * T1.2 adds runtime: defineAuth() + 4 typed error classes + validateReturnTo helper.
 */

export {
  AuthCallbackError,
  AuthCancelledError,
  AuthConfigError,
  AuthProviderNotFoundError,
} from "./errors.js";
// T5.1 — HKDF-SHA256 derivation rejects secrets < 32 bytes with this
// typed error. Surfaces on `defineAuth` callers whose env secret is
// too short (e.g., a 16-byte legacy value carried over from pre-T5.1).
export {
  AuthSecretTooShortError,
  clearTransactionCookie,
  readTransactionCookie,
  writeTransactionCookie,
} from "./oauth-transaction-store.js";

export { Auth } from "./orchestrator.js";
export type {
  AuthOrchestrator,
  AuthProvider,
  AuthResult,
  DefineAuthOptions,
  OAuthTransaction,
  SessionManager,
} from "./types.js";
export { validateReturnTo } from "./validate-return-to.js";
