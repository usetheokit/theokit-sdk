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

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { TrustRecordError } from "../../../errors.js";
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
 * The record's raw entries for a read-modify-write. Unlike {@link readTrustedWorkspaceFolders} it
 * is fail-loud: a record that exists but is not a JSON array throws `TrustRecordError`, so a
 * writer never overwrites what it could not read. A missing record is empty.
 */
export function readWorkspaceTrustRecordStrict(): unknown[] {
  const path = workspaceTrustRecordPath();
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (cause) {
    throw new TrustRecordError(`Workspace plugin trust record ${path} is not valid JSON`, {
      path,
      cause,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new TrustRecordError(`Workspace plugin trust record ${path} is not a JSON array`, {
      path,
    });
  }
  return parsed;
}
