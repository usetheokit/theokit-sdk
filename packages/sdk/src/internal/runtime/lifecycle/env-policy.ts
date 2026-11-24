/**
 * Child-process environment policy (#54).
 *
 * Every subprocess the SDK spawns previously inherited the FULL `process.env`,
 * so API keys, tokens and passwords leaked into hook scripts and shell tools.
 * `resolveChildEnv` computes the env a child receives under an explicit policy.
 *
 * Modes:
 *  - `inherit-scrubbed` (DEFAULT) — inherit all parent vars EXCEPT secret-like
 *    names (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*_AUTH*`). Non-breaking:
 *    existing spawns keep every non-secret var; only secrets stop leaking.
 *  - `core` — inherit ONLY a safe base allowlist (PATH/HOME/…); strongest scrub.
 *  - `all` — explicit opt-out: inherit everything, secrets included.
 *
 * Explicit `overrides` ALWAYS win (merged last), so a tool can re-inject a var
 * it genuinely needs even under a scrubbing policy.
 *
 * @internal
 */

import type { EnvPolicy } from "../../../types/env-policy.js";
import { isSecretEnvName } from "../../security/secret-env.js";

// The `EnvPolicy` contract now lives in the domain `types/` layer (SE46 DIP
// direction). Re-exported here so existing importers of this module keep
// resolving the same name.
export type { EnvPolicy } from "../../../types/env-policy.js";

export interface ResolveChildEnvOptions {
  /** Source env to derive from. Defaults to `process.env`. */
  parent?: Record<string, string | undefined>;
  /** Inherit/scrub policy. Defaults to `inherit-scrubbed`. */
  policy?: EnvPolicy;
  /** Explicit vars merged AFTER the policy — always win. */
  overrides?: Record<string, string>;
}

/**
 * Safe base variables kept under the `core` policy. Process-hygiene vars a
 * child almost always needs; none are secret-bearing.
 */
const CORE_VARS: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
];

/** Whether a parent var of the given name is inherited under `policy`. */
function inheritsUnderPolicy(name: string, policy: EnvPolicy): boolean {
  if (policy === "all") return true;
  if (policy === "core") return CORE_VARS.includes(name);
  return !isSecretEnvName(name); // inherit-scrubbed
}

export function resolveChildEnv(options: ResolveChildEnvOptions = {}): Record<string, string> {
  const parent = options.parent ?? process.env;
  const policy = options.policy ?? "inherit-scrubbed";

  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && inheritsUnderPolicy(name, policy)) base[name] = value;
  }

  // Explicit overrides always win — even over a scrub.
  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    base[name] = value;
  }
  return base;
}
