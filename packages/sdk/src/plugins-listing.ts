import { join } from "node:path";
import { resolveCompatSources } from "./internal/runtime/compat/compat-config-file.js";
import { resolveWorkspacePluginFolders } from "./internal/runtime/plugin-loader/plugins-manager.js";
import type { CompatSource } from "./types/agent.js";

/** One plugin an agent opened on this workspace would load. */
export interface WorkspacePluginListing {
  /** Manifest name, as the runtime registers it. */
  readonly name: string;
  /** The plugin folder. */
  readonly root: string;
  /** The manifest file the name was read from. */
  readonly manifestPath: string;
  readonly format: "claude-plugin-json" | "plugin-md" | "plugin-json";
}

/**
 * List the plugins an agent opened on `cwd` would load, without importing or running any plugin
 * code. Walks the same roots and resolves manifests with the same code as the runtime, so a
 * malformed manifest rejects with the same `ConfigurationError`. Reads the project's
 * `.theokit/plugins` plus the plugin roots of the declared `compatSources`; never `~/.theokit`.
 * The `enabled` filter is not applied.
 */
export async function listWorkspacePlugins(
  cwd: string,
  options?: { compatSources?: readonly CompatSource[] },
): Promise<WorkspacePluginListing[]> {
  const sources = resolveCompatSources(
    { local: options?.compatSources === undefined ? {} : { compatSources: options.compatSources } },
    cwd,
  );
  const found = await resolveWorkspacePluginFolders(cwd, sources);
  return found.map((f) => ({
    name: f.metadata.name,
    root: join(f.root, f.folder),
    manifestPath: f.manifestPath,
    format: f.format,
  }));
}
