/**
 * B-686 — import the `entry` of each trusted workspace manifest plugin.
 *
 * `PluginsManager` lists a folder under `<cwd>/.theokit/plugins/<folder>/` whose `PLUGIN.md` names an
 * `entry`; this step decides whether that code runs. The folder's realpath is checked against the
 * workspace trust record (`workspace-plugin-trust.ts`) before any `import()`, never its name: a
 * cloned workspace chooses its folder names, so a name in the provider trust list authorizes
 * nothing here (review round 1, CWE-829). An untrusted folder's code is never evaluated, and it is
 * diagnosed once per folder per process. A trusted entry whose import throws,
 * or whose default export is not a general plugin, fails `Agent.create` with a typed error rather
 * than being skipped: the operator trusted that code, so dropping it silently would hide a bug.
 *
 * @internal
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConfigurationError } from "../../../errors.js";
import { diag } from "../../diagnostics.js";
import { globalSingleton } from "../../global-singleton.js";
import { isCodePlugin } from "../../plugins/plugin-guards.js";
import type { Plugin } from "../../plugins/types.js";
import type { ManifestEntryCandidate } from "./plugins-manager.js";
import { workspaceTrustRecordPath } from "./workspace-plugin-trust.js";

// On `globalThis`, not module-local: tsup bundles each entry with its own module copy, and the
// diagnostic is once per process, not once per bundle copy (edge case EC-1). Tests clear it through
// the same `globalSingleton` key, so no test-only export ships.
const warnedFolders = globalSingleton(
  "theokit-sdk.plugins.manifest-untrusted-warned",
  () => new Set<string>(),
);

export async function importTrustedManifestPlugins(
  candidates: ReadonlyArray<ManifestEntryCandidate>,
  trustedFolders: ReadonlySet<string>,
): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const candidate of candidates) {
    const realFolder = realpathOrUndefined(candidate.folderPath);
    if (realFolder === undefined || !trustedFolders.has(realFolder)) {
      warnUntrustedOnce(candidate, realFolder ?? candidate.folderPath);
      continue;
    }
    plugins.push(await importEntry(candidate));
  }
  return plugins;
}

/** The folder's realpath; a folder that cannot be resolved is never trusted. */
function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function warnUntrustedOnce(candidate: ManifestEntryCandidate, realFolder: string): void {
  // A folder has one entry, so its absolute entry path identifies the folder across cwds.
  if (warnedFolders.has(candidate.entryPath)) return;
  warnedFolders.add(candidate.entryPath);
  const { folder, metadata } = candidate;
  const declared = metadata.name === folder ? "" : ` (declares name "${metadata.name}")`;
  diag(
    `[theokit-sdk] workspace plugin folder "${folder}"${declared} is not trusted — its entry was not imported. ` +
      `To trust it, add "${realFolder}" to ${workspaceTrustRecordPath()} (JSON array of folder realpaths).\n`,
  );
}

async function importEntry(candidate: ManifestEntryCandidate): Promise<Plugin> {
  const { metadata } = candidate;
  const entry = metadata.entry ?? "";
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(candidate.entryPath).href)) as { default?: unknown };
  } catch (cause) {
    throw new ConfigurationError(`Plugin ${metadata.name} entry failed to import: ${entry}`, {
      code: "plugin_entry_import_failed",
      cause,
    });
  }
  const plugin = mod.default;
  if (!isGeneralPlugin(plugin)) {
    throw new ConfigurationError(
      `Plugin ${metadata.name} entry must default-export a general plugin (kind "general", name, register): ${entry}`,
      { code: "plugin_entry_shape" },
    );
  }
  return plugin;
}

function isGeneralPlugin(value: unknown): value is Plugin {
  return (
    isCodePlugin(value) &&
    value.kind === "general" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}
