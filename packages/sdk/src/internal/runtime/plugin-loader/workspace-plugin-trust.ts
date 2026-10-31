/**
 * B-686 — the trust record for workspace manifest plugins.
 *
 * A folder under `<cwd>/.theokit/plugins/<folder>/` is code a cloned repository ships, and the
 * repository chooses the folder's name. So the record is keyed on what the workspace cannot
 * choose: the folder's absolute realpath, in `~/.theokit/plugins/trusted-workspace-plugins.json`
 * (a JSON array). It is a record of its own: a name in the provider trust list
 * (`providers/trust-gate.ts`) authorizes no workspace folder. Read on every call, never cached;
 * fail-closed like the provider list, whose reader it shares.
 *
 * @internal
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { diag } from "../../diagnostics.js";
import { readTrustArray, type TrustArrayShape } from "../../providers/trust-gate.js";

const WORKSPACE_TRUST: TrustArrayShape = {
  subject: "workspace plugins",
  entries: "absolute folder realpaths",
};

export function workspaceTrustRecordPath(): string {
  return join(homedir(), ".theokit", "plugins", "trusted-workspace-plugins.json");
}

/** The folder realpaths the operator trusted; a relative entry is discarded with a WARN. */
export function readTrustedWorkspaceFolders(): Set<string> {
  const path = workspaceTrustRecordPath();
  const trusted = new Set<string>();
  for (const entry of readTrustArray(path, WORKSPACE_TRUST)) {
    if (isAbsolute(entry)) {
      trusted.add(entry);
      continue;
    }
    diag(
      `[theokit-sdk] WARN: ${path} entry "${entry}" is not an absolute path — discarded (entries must be ${WORKSPACE_TRUST.entries})\n`,
    );
  }
  return trusted;
}
