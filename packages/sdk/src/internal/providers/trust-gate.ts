/**
 * The trust gate for provider plugins loaded from disk (M47, B-686).
 *
 * Provider discovery (`discovery.ts`) reads this list of NAMES; it authorizes only
 * `~/.theokit/plugins/model-providers/<name>/`, a folder in the operator's own home. Workspace
 * manifest plugins never consult it: a cloned workspace chooses its folder names, so they are
 * trusted by realpath in a record of their own (`runtime/plugin-loader/workspace-plugin-trust.ts`),
 * which shares the fail-closed file reader below. Both are read on every call and never cached, so
 * an entry the operator adds takes effect on the next `Agent.create` rather than after a restart.
 *
 * @internal
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { diag } from "../diagnostics.js";

/** The explicit trust allowlist the human edits (M47). Fail-closed: missing/malformed ⇒ empty. */
export function trustFilePath(): string {
  return join(homedir(), ".theokit", "plugins", "trusted-providers.json");
}

/**
 * M47 — the trust gate for the dynamic-import surface. A plugin's entry executes arbitrary code
 * at import time, so NOTHING is imported unless the human explicitly trusted the name: either in
 * `~/.theokit/plugins/trusted-providers.json` (a JSON string array — the auditable primary, mirroring the
 * approved-hooks posture) or the additive `THEOKIT_TRUSTED_PROVIDERS` env (comma-separated convenience).
 * Fail-closed: a missing or malformed trust file trusts NOTHING (a malformed file WARNs).
 */
export function readTrustedNames(): Set<string> {
  const trusted = new Set(readTrustArray(trustFilePath(), PROVIDER_TRUST));
  for (const name of (process.env.THEOKIT_TRUSTED_PROVIDERS ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed.length > 0) trusted.add(trimmed);
  }
  return trusted;
}

/** What a trust file holds, as its fail-closed warnings name it. */
export interface TrustArrayShape {
  /** What a malformed file leaves untrusted, e.g. "provider plugins". */
  readonly subject: string;
  /** What each entry must be, e.g. "plugin-name strings". */
  readonly entries: string;
}

const PROVIDER_TRUST: TrustArrayShape = {
  subject: "provider plugins",
  entries: "plugin-name strings",
};

/**
 * The non-empty strings in a JSON-array trust file. Fail-closed: a missing file is empty, and a
 * malformed one (not JSON, not an array) is empty with a WARN; non-string entries are discarded
 * with a WARN.
 */
export function readTrustArray(path: string, shape: TrustArrayShape): string[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    diag(
      `[theokit-sdk] WARN: ${path} is not valid JSON — trusting NO ${shape.subject} (fail-closed)\n`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    diag(
      `[theokit-sdk] WARN: ${path} is not a JSON array — trusting NO ${shape.subject} (fail-closed)\n`,
    );
    return [];
  }
  const names = parsed.filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
  const discarded = parsed.length - names.length;
  // M47 review F5 — fail-closed AND fail-clear: a valid array with wrong-shaped entries (numbers,
  // objects) silently trusting nothing would leave the user with only the generic per-plugin WARN
  // and no clue the FILE shape is wrong.
  if (discarded > 0) {
    diag(
      `[theokit-sdk] WARN: ${path} contains ${discarded} non-string entr${discarded === 1 ? "y" : "ies"} — discarded (entries must be ${shape.entries})\n`,
    );
  }
  return names;
}
