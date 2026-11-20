/**
 * Orchestrator types (Path C Hybrid per G11) — `@theokit/sdk/server/auth`.
 *
 * Plan: g11-auth-architecture-implementation v1.4 (sha256 4d381020...)
 * Blueprint: g11-auth-architecture-decision v1.1 (SHIPPABLE 97.9)
 * AUTH-DELEGATION lock (theokit/CLAUDE.md:217-225) — these types are the
 * orchestrator contract; concrete OAuth/email providers ship in opt-in
 * @theokit/auth-* packages (adapters layer per ADR D11).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * SessionManager contract (matches theokit/packages/theo/src/server/auth/session.ts:49).
 * Imported as type-only — runtime depends via peerDep `theokit@>=0.2.4`.
 */
export interface SessionManager<TSession> {
  getSession(req: IncomingMessage): Promise<TSession | null>;
  createSession(res: ServerResponse, data: TSession): Promise<void>;
  destroySession(res: ServerResponse): void;
  rotateSession(req: IncomingMessage, res: ServerResponse): Promise<TSession | null>;
  /**
   * The secret used to encrypt the OAuth transaction cookie, when this manager has one to share.
   *
   * OPTIONAL and additive: a manager without it makes `defineAuth` fall back to
   * `THEOKIT_OAUTH_TX_SECRET`, which is the behaviour that already existed.
   *
   * It exists because the orchestrator was reading `session.secret` through
   * `as unknown as { secret?: string | string[] }` — asserting a shape this contract did not offer,
   * so no conforming caller could reach the branch and nothing in `src/` supplied it. The branch was
   * green only because a test double carried the field. `orchestrator.ts` said in a comment that it
   * WANTED this member ("may refactor to share the SessionManager's actual secret rotation chain via
   * a `getCookieSecret()` method"); declaring it is what makes the branch reachable through the port
   * and the double conform instead of the reverse.
   *
   * An array is accepted for rotation: the first entry encrypts, and the rest are for verifying
   * cookies written before the last rotation.
   */
  /**
   * Web counterpart of `createSession`: appends the session `Set-Cookie` to `headers`. OPTIONAL;
   * required only for `finishSignInWeb`. It must issue a fresh session (no reuse of a prior
   * session id), because the Web flow has no `rotateSession` step.
   */
  createSessionWeb?(headers: Headers, data: TSession): Promise<void>;
  getCookieSecret?(): string | string[] | undefined;
}

/**
 * Per ADR D5 — OAuth transaction state stored in encrypted HttpOnly cookie
 * (cookie-state pattern). Expires within 10 minutes per invariant.
 */
export interface OAuthTransaction {
  state: string;
  pkceVerifier?: string;
  returnTo?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Per ADR D9 — provider profile types are provider-specific (not unified).
 * Each @theokit/auth-* package exports its own profile shape.
 * Generic param TProfile lets consumers narrow via discriminated unions on providerName.
 */
export interface AuthResult<TProfile, TName extends string = string> {
  profile: TProfile;
  providerName: TName;
  rawTokens?: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAt?: number;
  };
}

/**
 * Provider contract — each @theokit/auth-* package implements this.
 * Per blueprint Q5 + ADR D11 (adapters layer).
 */
export interface AuthProvider<TProfile, TName extends string = string> {
  name: TName;
  createAuthorizationURL(tx: OAuthTransaction): URL | Promise<URL>;
  handleCallback(
    req: Request | IncomingMessage,
    tx: OAuthTransaction,
  ): Promise<AuthResult<TProfile, TName>>;
}

/**
 * `defineAuth(opts)` configuration shape — Path C (Hybrid).
 * `providers` optional: empty = Path A escape hatch (manual signIn only).
 * `onSignIn` invoked after provider callback success; returns TSession to persist.
 */
export interface DefineAuthOptions<TSession> {
  session: SessionManager<TSession>;
  providers?: AuthProvider<unknown, string>[];
  onSignIn?: <TProfile>(args: { profile: TProfile; provider: string }) => Promise<TSession>;
  onSignOut?: (session: TSession | null) => Promise<void> | void;
}

/**
 * Returned by `defineAuth<TSession>(opts)` — 5-method orchestrator surface.
 *
 * - startSignIn: returns Response.redirect to provider authorization URL with state cookie
 * - finishSignIn: handles provider callback; verifies state; calls onSignIn; rotates session ID
 *   (OWASP A07:2021 per EC-10); creates session cookie; clears transaction cookie
 * - signIn: Path A escape hatch — skip OAuth flow; directly persist session from external profile
 * - signOut: destroys session cookie + invokes onSignOut callback
 * - getSession: read-only passthrough to session.getSession
 */
export interface AuthOrchestrator<TSession> {
  startSignIn(
    providerName: string,
    req: IncomingMessage,
    opts?: { returnTo?: string },
  ): Promise<Response>;
  finishSignIn(
    providerName: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ session: TSession; returnTo?: string }>;
  /** Web `Request` variant of `startSignIn`; sets the transaction cookie on the 302. */
  startSignInWeb(
    providerName: string,
    request: Request,
    opts?: { returnTo?: string },
  ): Promise<Response>;
  /**
   * Web variant of `finishSignIn`: clears the transaction cookie and writes the session cookie
   * into `responseHeaders` (needs `SessionManager.createSessionWeb`). The provider receives the
   * `Request`, so it must accept Web requests.
   */
  finishSignInWeb(
    providerName: string,
    request: Request,
    responseHeaders: Headers,
  ): Promise<{ session: TSession; returnTo?: string }>;
  signIn<TProfile>(
    profile: TProfile,
    providerName: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<TSession>;
  signOut(res: ServerResponse): void | Promise<void>;
  getSession(req: IncomingMessage): Promise<TSession | null>;
}
