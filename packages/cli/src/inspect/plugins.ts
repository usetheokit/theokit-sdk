/**
 * Plugin discovery for `theokit inspect` (T3.1, ADR D198).
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
  readonly source: "project";
  readonly path: string;
  readonly format: "claude-plugin-json" | "plugin-md" | "plugin-json";
}

/**
 * List the plugins an agent opened on `cwd` would load, sorted by name.
 *
 * Only the project root (`<cwd>/.theokit/plugins`) is read; the CLI declares no compat sources, and
 * `~/.theokit/plugins` is never read because the runtime does not load it. A malformed manifest
 * rejects with the SDK's `ConfigurationError`, as it would when an agent starts.
 */
export async function listPlugins(cwd: string): Promise<PluginInfo[]> {
  const found = await listWorkspacePlugins(cwd);
  return found
    .map(
      (p): PluginInfo => ({
        name: p.name,
        source: "project",
        path: p.manifestPath,
        format: p.format,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
