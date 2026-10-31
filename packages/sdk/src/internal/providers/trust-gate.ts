/**
 * The trust gate for code loaded from disk (M47, B-686).
 *
 * One list, read by both readers that import code from a folder: provider discovery
 * (`discovery.ts`) and the workspace manifest step (`manifest-entry-import.ts`). It is read on
 * every call and never cached, so a name the operator trusts takes effect on the next
 * `Agent.create` rather than after a restart.
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
// PRE-EXISTING debt, exposed when M75 fixed the Biome config that used to abort before
// sweeping these files (a nested root under refactor/). It is not new code and was not touched
// by M75 or B-686 (moved verbatim from discovery.ts); tracked in usetheodev/theokit-sdk#151.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see the reason just above
export function readTrustedNames(): Set<string> {
  const trusted = new Set<string>();
  const path = trustFilePath();
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (Array.isArray(parsed)) {
        let discarded = 0;
        for (const name of parsed) {
          if (typeof name === "string" && name.length > 0) trusted.add(name);
          else discarded += 1;
        }
        // M47 review F5 — fail-closed AND fail-clear: a valid array with wrong-shaped entries
        // (numbers, objects) silently trusting nothing would leave the user with only the generic
        // per-plugin WARN and no clue the FILE shape is wrong.
        if (discarded > 0) {
          diag(
            `[theokit-sdk] WARN: ${path} contains ${discarded} non-string entr${discarded === 1 ? "y" : "ies"} — discarded (entries must be plugin-name strings)\n`,
          );
        }
      } else {
        diag(
          `[theokit-sdk] WARN: ${path} is not a JSON array — trusting NO provider plugins (fail-closed)\n`,
        );
      }
    } catch {
      diag(
        `[theokit-sdk] WARN: ${path} is not valid JSON — trusting NO provider plugins (fail-closed)\n`,
      );
    }
  }
  for (const name of (process.env.THEOKIT_TRUSTED_PROVIDERS ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed.length > 0) trusted.add(trimmed);
  }
  return trusted;
}
