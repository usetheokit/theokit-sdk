// Validation of `CredentialRule` sets and host matching, split out of egress-proxy.ts.

import { ConfigurationError } from "../errors.js";

/** One destination the proxy lets through. */
export interface EgressRule {
  /** `"registry.npmjs.org"`, `"*.github.com"` (subdomains only), or an IP literal, listed exactly. */
  readonly host: string;
  /** Allowed destination ports. Default `[80, 443]`. */
  readonly ports?: readonly number[];
}

/** A credential the proxy adds to requests for one host, so the sandbox only holds `placeholder`. */
export interface CredentialRule {
  /** Host the credential is for; must also be allowed by an `EgressRule`. */
  readonly host: string;
  /** Header the credential goes in, e.g. `"authorization"`. */
  readonly header: string;
  /** Read on the host for every request. Never logged, never written into the sandbox. */
  readonly value: () => string | Promise<string>;
  /** What the sandbox sees, e.g. `"THEOKIT_PLACEHOLDER_GITHUB"`. Replaced by `value()` in `header`. */
  readonly placeholder: string;
  /** Environment variable set to `placeholder` inside the sandbox. */
  readonly envVar?: string;
}

export const BAD_HEADER_VALUE = /[\r\n\0]/;
const MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** Lower-cased, dot-trimmed, bracket-free host; IPv4-mapped IPv6 reduced to its IPv4 form. */
export function normalizeHost(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return MAPPED.exec(h)?.[1] ?? h;
}

export function hostMatches(ruleHost: string, host: string): boolean {
  const r = normalizeHost(ruleHost);
  if (r.startsWith("*.")) return host.endsWith(r.slice(1)) && host.length > r.length - 1;
  return r === host;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalidRule(message: string, code = "invalid_credential_rule"): never {
  throw new ConfigurationError(message, { code });
}

function validateRuleShape(c: CredentialRule): void {
  if (!HEADER_NAME.test(c.header)) invalidRule(`invalid header "${c.header}"`);
  if (!c.placeholder || BAD_HEADER_VALUE.test(c.placeholder)) {
    invalidRule("placeholder must be a non-empty single-line string");
  }
  if (c.envVar !== undefined && !ENV_NAME.test(c.envVar))
    invalidRule(`invalid envVar "${c.envVar}"`);
}

function validateRuleSet(credentials: readonly CredentialRule[]): void {
  const seenEnv = new Set<string>();
  for (const [i, c] of credentials.entries()) {
    if (credentials.some((o, j) => j !== i && o.placeholder.includes(c.placeholder))) {
      invalidRule("placeholders must be distinct and must not contain one another");
    }
    if (c.envVar === undefined) continue;
    if (seenEnv.has(c.envVar)) invalidRule(`duplicate envVar "${c.envVar}"`);
    seenEnv.add(c.envVar);
  }
}

/** Throw `ConfigurationError` for a credential rule set the proxy cannot enforce safely. */
export function validateCredentialRules(
  allow: readonly EgressRule[],
  credentials: readonly CredentialRule[],
): void {
  for (const c of credentials) {
    const host = normalizeHost(c.host);
    if (!allow.some((r) => normalizeHost(r.host) === host || hostMatches(r.host, host))) {
      invalidRule(
        `credential rule for "${c.host}" has no matching egress rule`,
        "credential_host_not_allowed",
      );
    }
    validateRuleShape(c);
  }
  validateRuleSet(credentials);
}
