/**
 * B-686: the trust record for workspace manifest plugins, as the tests write it.
 *
 * The record is `~/.theokit/plugins/trusted-workspace-plugins.json`, a JSON array of folder
 * realpaths. `HOME` is a fresh tmpdir per test (`vitest.setup.ts`), so each test's record is its own.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function workspaceTrustRecordPath(): string {
  return join(homedir(), ".theokit", "plugins", "trusted-workspace-plugins.json");
}

/** Write `content` as the workspace trust record, verbatim. */
export function writeWorkspaceTrustRecord(content: string): void {
  mkdirSync(join(homedir(), ".theokit", "plugins"), { recursive: true });
  writeFileSync(workspaceTrustRecordPath(), content);
}

/** Add `entry` to the record as given, without resolving it. */
export function trustWorkspacePath(entry: string): void {
  const path = workspaceTrustRecordPath();
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : [];
  writeWorkspaceTrustRecord(JSON.stringify([...current, entry]));
}

/** Trust the plugin folder `dir` by its realpath, the key the SDK checks. */
export function trustWorkspaceFolder(dir: string): void {
  trustWorkspacePath(realpathSync(dir));
}
