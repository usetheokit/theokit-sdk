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

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { diag } from "../../diagnostics.js";
import { readTrustArray, type TrustArrayShape, trustFilePath } from "../../providers/trust-gate.js";

const WORKSPACE_TRUST: TrustArrayShape = {
  subject: "workspace plugins",
  entries: "absolute folder realpaths",
};

/** Beside the provider trust file, in `~/.theokit/plugins/`. */
export function workspaceTrustRecordPath(): string {
  return join(dirname(trustFilePath()), "trusted-workspace-plugins.json");
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

/**
 * The raw record for a read-modify-write. Unlike {@link readTrustedWorkspaceFolders} it does not
 * fail closed to empty: `null` is a missing file, and a record that cannot be read as an array of
 * strings is reported through `onInvalid` (which throws) so a caller never overwrites it.
 */
export function readWorkspaceTrustRecordStrict(
  onInvalid: (path: string, reason: string, cause?: unknown) => never,
): string[] {
  const path = workspaceTrustRecordPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return onInvalid(path, "cannot be read", err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return onInvalid(path, "is not valid JSON", err);
  }
  if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) {
    return onInvalid(path, "is not a JSON array of folder paths");
  }
  return parsed as string[];
}
