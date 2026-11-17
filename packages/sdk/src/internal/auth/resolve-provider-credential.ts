/**
 * `resolveProviderCredential` — "given this env, this store and this model, which provider and which
 * key?" answered once, in the package that owns every fact the answer depends on.
 *
 * Rules, in order:
 *  1. `pinnedEnvVar` set: use that variable; empty or missing is `pinned_credential_missing`.
 *  2. The model names a provider (`provider/name`): use that provider's credential (env, then store).
 *     None is `model_provider_without_credential`; it never falls back to another provider.
 *  3. Bare model id or no model: the first candidate by `priority` that has a credential, else
 *     `no_provider_credential` listing the variables checked.
 *  4. A key whose prefix names a different vendor than the provider it was found for is
 *     `credential_provider_mismatch`.
 *
 * Error messages name variables, never values. Public via `@theokit/sdk/auth`.
 */

import { ConfigurationError } from "../../errors.js";
import { getProviderProfile } from "../../providers.js";
import { parseModelId } from "../llm/model-identifier.js";
import { providerFromApiKeyPrefix } from "./api-key-prefix.js";
import { resolveCredential } from "./resolve-credential.js";
import type { CredentialStoreConfig } from "./types.js";

/** One provider the resolver may pick for a bare model id. */
export interface ProviderCandidate {
  /** A provider profile name. */
  readonly name: string;
  /** The variable holding its key. */
  readonly envVar: string;
  /** Lower wins for a bare model id. */
  readonly priority: number;
}

/** Where the key came from. */
export type CredentialOrigin =
  | { kind: "env"; envVar: string }
  | { kind: "store"; path: string }
  | { kind: "pinned"; envVar: string };

/** The provider chosen and its key. */
export interface ResolvedProviderCredential {
  readonly provider: string;
  readonly apiKey: string;
  readonly origin: CredentialOrigin;
  /** From the provider profile. */
  readonly baseUrl: string;
}

/**
 * The default order for a bare model id: openrouter, anthropic, openai. It matches the chain the
 * measured consumer (`@theokit/agents`) already uses.
 */
export const DEFAULT_PROVIDER_CANDIDATES: readonly ProviderCandidate[] = [
  { name: "openrouter", envVar: "OPENROUTER_API_KEY", priority: 1 },
  { name: "anthropic", envVar: "ANTHROPIC_API_KEY", priority: 2 },
  { name: "openai", envVar: "OPENAI_API_KEY", priority: 3 },
];

/** Thrown when no provider credential can be chosen; branch on `code`. */
export class ProviderCredentialError extends ConfigurationError {
  override readonly name: string = "ProviderCredentialError";
}

/** Input to {@link resolveProviderCredential}: the env, the optional model and store, and overrides. */
export interface ResolveProviderCredentialInput {
  env: Record<string, string | undefined>;
  model?: string;
  store?: CredentialStoreConfig;
  providers?: readonly ProviderCandidate[];
  pinnedEnvVar?: string;
}

/** Vendors whose key prefix is known; only these can be contradicted by a prefix. */
const PREFIXED = new Set(["openrouter", "anthropic", "openai"]);

interface Found {
  apiKey: string;
  origin: CredentialOrigin;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function varFor(provider: string, candidates: readonly ProviderCandidate[]): string | undefined {
  const c = candidates.find((x) => x.name === provider);
  return c?.envVar ?? getProviderProfile(provider)?.envVars[0];
}

async function find(
  provider: string,
  envVar: string | undefined,
  input: ResolveProviderCredentialInput,
): Promise<Found | undefined> {
  if (envVar !== undefined) {
    const apiKey = envValue(input.env, envVar);
    if (apiKey !== undefined) return { apiKey, origin: { kind: "env", envVar } };
  }
  if (input.store === undefined) return undefined;
  const stored = await resolveCredential({ provider, store: input.store, env: input.env });
  if (stored === undefined || stored.apiKey.length === 0) return undefined;
  return { apiKey: stored.apiKey, origin: { kind: "store", path: stored.source } };
}

function finish(provider: string, found: Found): ResolvedProviderCredential {
  const issuer = providerFromApiKeyPrefix(found.apiKey);
  if (issuer !== undefined && issuer !== provider && PREFIXED.has(provider)) {
    const where = found.origin.kind === "store" ? "the credential store" : found.origin.envVar;
    throw new ProviderCredentialError(
      `The credential in ${where} looks like a ${issuer} key but was found for provider "${provider}"; refusing to send it to the wrong vendor.`,
      { code: "credential_provider_mismatch" },
    );
  }
  return {
    provider,
    apiKey: found.apiKey,
    origin: found.origin,
    baseUrl: getProviderProfile(provider)?.baseUrl ?? "",
  };
}

async function resolvePinned(
  pinned: string,
  input: ResolveProviderCredentialInput,
  candidates: readonly ProviderCandidate[],
): Promise<ResolvedProviderCredential> {
  const apiKey = envValue(input.env, pinned);
  if (apiKey === undefined) {
    throw new ProviderCredentialError(
      `The pinned credential variable ${pinned} is empty or not set.`,
      { code: "pinned_credential_missing" },
    );
  }
  const provider =
    parseModelId(input.model).provider ??
    candidates.find((c) => c.envVar === pinned)?.name ??
    providerFromApiKeyPrefix(apiKey);
  if (provider === undefined) {
    throw new ProviderCredentialError(
      `The provider for the pinned credential variable ${pinned} cannot be determined; name it in the model id.`,
      { code: "pinned_credential_missing" },
    );
  }
  return finish(provider, { apiKey, origin: { kind: "pinned", envVar: pinned } });
}

async function resolveNamed(
  provider: string,
  input: ResolveProviderCredentialInput,
  candidates: readonly ProviderCandidate[],
): Promise<ResolvedProviderCredential> {
  const envVar = varFor(provider, candidates);
  const found = await find(provider, envVar, input);
  if (found === undefined) {
    const which = envVar === undefined ? "no known credential variable" : envVar;
    throw new ProviderCredentialError(
      `Model provider "${provider}" has no credential (checked ${which}); not falling back to another provider.`,
      { code: "model_provider_without_credential" },
    );
  }
  return finish(provider, found);
}

async function resolveByPriority(
  input: ResolveProviderCredentialInput,
  candidates: readonly ProviderCandidate[],
): Promise<ResolvedProviderCredential> {
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority);
  for (const c of ordered) {
    const found = await find(c.name, c.envVar, input);
    if (found !== undefined) return finish(c.name, found);
  }
  const vars = ordered.map((c) => c.envVar).join(", ");
  throw new ProviderCredentialError(`No provider credential found (checked ${vars}).`, {
    code: "no_provider_credential",
  });
}

/** Choose the provider and key for `input.model` in `input.env`; see the module docblock for the rules. */
export async function resolveProviderCredential(
  input: ResolveProviderCredentialInput,
): Promise<ResolvedProviderCredential> {
  const candidates = input.providers ?? DEFAULT_PROVIDER_CANDIDATES;
  if (input.pinnedEnvVar !== undefined) return resolvePinned(input.pinnedEnvVar, input, candidates);
  const named = parseModelId(input.model).provider;
  if (named !== undefined) return resolveNamed(named, input, candidates);
  return resolveByPriority(input, candidates);
}
