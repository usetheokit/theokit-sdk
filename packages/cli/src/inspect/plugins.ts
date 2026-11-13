/**
 * Plugin discovery for `theokit inspect`.
 *
 * Delegates to the SDK's `listWorkspacePlugins`, so the listing is exactly what an agent started in
 * the same `cwd` would load. Does NOT execute plugin code (safe to run in CI).
 *
 * @internal
 */

import { listWorkspacePlugins } from "@theokit/sdk";

/** One discovered plugin. `path` points at its manifest file, not at the plugin directory. */
interface PluginInfo {
  readonly name: string;
  /** Always `"project"`: the runtime never reads `~/.theokit/plugins`, so `user-global` is gone. */
  readonly source: "project";
  readonly path: string;
}

/**
 * List the plugins an agent started in `cwd` would load, sorted by name.
 *
 * Reads the project's `.theokit/plugins` only; the CLI declares no Claude Code compat sources, so
 * `.claude/plugins` is not listed. Rejects with the SDK's `ConfigurationError` on a malformed
 * manifest, exactly as the runtime does. Never executes plugin code.
 */
export async function listPlugins(cwd: string): Promise<PluginInfo[]> {
  const found = await listWorkspacePlugins(cwd);
  return found
    .map((p) => ({ name: p.name, source: "project" as const, path: p.manifestPath }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
