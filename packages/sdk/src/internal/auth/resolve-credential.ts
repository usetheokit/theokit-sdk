/**
 * M42 — `resolveCredential`: the public composition entrypoint over the credential store + oauth engine.
 * Given a provider name + a {@link CredentialStoreConfig} (and, for oauth, an {@link OAuthProviderConfig}),
 * read the store and return a FRESH `ResolvedCredential` — an api credential passes through by identity; an
 * oauth credential is transparently refreshed when its access token is within the skew window. Returns
 * `undefined` when the store holds no credential for `provider` (the caller then falls back to env / apiKeys).
 *
 * Mirrors agent-builder's `resolveFreshCredential` composition (store read → oauth → ensureFreshCredential),
 * defaulting `fetch`/`now` to globals. This is the async surface an oauth provider's M41 `transform.fetch`
 * calls at stream time, so a mid-turn token expiry refreshes without rebuilding the agent.
 *
 * Re-exported from `@theokit/sdk/auth`, and therefore PUBLIC, under semver.
 *
 * NOTE — no internal-visibility tag in this block. `tsconfig.base.json` sets `stripInternal: true`,
 * and TypeScript scans EVERY leading comment range of the declaration that follows, including the
 * import right below this one. The tag that used to sit here deleted that import from the emitted
 * `.d.ts`, leaving the types it binds unresolvable for any consumer running type-aware lint
 * (usetheodev/theokit-sdk#283 records the same trap on a declaration).
 */

import { boundFetch } from "../runtime-fetch.js";
import { authFilePath, readAuthFile } from "./credential-store.js";
import { ensureFreshCredential } from "./oauth-engine.js";
import type {
  CredentialStoreConfig,
  HttpDeps,
  OAuthProviderConfig,
  ResolvedCredential,
} from "./types.js";

/**
 * Input to `resolveCredential`: which provider, which store, and what to inject.
 *
 * `env` and `deps` exist so nothing here reads ambient state. Omitting `env` does NOT fall back to
 * `process.env` — the store's `homeEnvVar` override simply goes unread, so a credential written
 * under a relocated home resolves as absent rather than as an error.
 *
 * `oauth` is required only to REFRESH an oauth credential. Without it an expired oauth entry cannot
 * be renewed, and an api-key-only store needs it never.
 *
 * PUBLIC and under semver, despite the `internal/` directory: `src/auth/index.ts` re-exports this
 * type, and `package.json` publishes that barrel as the '@theokit/sdk/auth' subpath. The directory
 * name is not the authority — the `exports` map is. The semver-exempt class is the sub-paths
 * declared under '@theokit/sdk/internal/*' ('internal/persistence', 'internal/security',
 * 'internal/memory-adapters'); no `exports` entry reaches this file that way.
 */
export interface ResolveCredentialOptions {
  /** The provider whose stored credential to resolve. */
  provider: string;
  /** Where the credential store lives. */
  store: CredentialStoreConfig;
  /** Env for the store's optional `homeEnvVar` override. Never an ambient read. */
  env?: Record<string, string | undefined>;
  /** Required to refresh an oauth credential; omit for an api-only store. */
  oauth?: OAuthProviderConfig;
  /** Injected HTTP + clock for deterministic tests; default globals. */
  deps?: { fetch?: typeof fetch; now?: () => number };
}

/** Resolve (and, when a config is supplied, refresh) the oauth variant for the requested provider. */
async function resolveOAuth(
  stored: { provider: string; access: string; expires: number },
  path: string,
  opts: ResolveCredentialOptions,
  env: Record<string, string | undefined>,
): Promise<ResolvedCredential | undefined> {
  if (stored.provider !== opts.provider) return undefined;
  const base: ResolvedCredential = {
    kind: "oauth",
    provider: opts.provider,
    apiKey: stored.access,
    source: path,
    inferred: false,
    expiresAt: stored.expires,
  };
  if (opts.oauth === undefined) return base; // no config to refresh with — return the stored access token
  const deps: HttpDeps = {
    fetch: boundFetch(opts.deps?.fetch),
    now: opts.deps?.now ?? (() => Date.now()),
  };
  return ensureFreshCredential(base, { config: opts.oauth, store: opts.store, env }, deps);
}

/**
 * Resolve a fresh credential for `provider` from the store, or `undefined` if the store holds none for it.
 * oauth credentials are auto-refreshed when `opts.oauth` is supplied; api credentials pass through.
 */
export async function resolveCredential(
  opts: ResolveCredentialOptions,
): Promise<ResolvedCredential | undefined> {
  const env = opts.env ?? {};
  const stored = readAuthFile(opts.store, env);
  if (stored === undefined) return undefined;

  const path = authFilePath(opts.store, env);

  if (stored.type === "oauth") {
    return resolveOAuth(stored, path, opts, env);
  }

  // api variant: require the stored `provider` to MATCH the requested provider (M42 review MEDIUM-2).
  // The generic SDK cannot infer a provider from a key prefix (that was agent-builder app policy), so a
  // provider-less or mismatched stored key is NOT attributed to the requested provider — otherwise a legacy
  // `{api_key:"sk-ant-…"}` file could be POSTed to the wrong vendor's endpoint (cross-vendor key exposure).
  // Fail-closed: credential resolution never attributes a key across providers.
  if (stored.api_key.length === 0) return undefined;
  if (stored.provider !== opts.provider) return undefined;
  return {
    kind: "api",
    provider: opts.provider,
    apiKey: stored.api_key,
    source: path,
    inferred: false,
  };
}
