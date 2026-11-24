import type { PluginsSettings } from "../../types/providers.js";
import type { Plugin } from "./types.js";

/**
 * Type guard: is the `AgentOptions.plugins` value the array (code-`Plugin`)
 * form rather than the named-enable settings form?
 *
 * `Array.isArray` alone does not narrow a `readonly Plugin[]` out of the union
 * (its built-in predicate is `arg is any[]`, which excludes readonly arrays),
 * so we wrap it in a predicate that names the readonly array explicitly.
 */
function isPluginArray(plugins: PluginsSettings | readonly Plugin[]): plugins is readonly Plugin[] {
  return Array.isArray(plugins);
}

/**
 * Narrow the `AgentOptions.plugins` union to the named-enable settings form,
 * collapsing the array (code-`Plugin`) form to `undefined`. Use this where the
 * distinction between `undefined` ("no filter / load all") and `[]` ("explicit
 * empty") matters — e.g. the file-discovery plugin filter and registry
 * serialization. Code `Plugin` objects are handled separately by
 * `extractCodePlugins` and cannot be persisted, so they map to `undefined`.
 *
 * @internal
 */
export function asPluginsSettings(
  plugins: PluginsSettings | readonly Plugin[] | undefined,
): PluginsSettings | undefined {
  if (plugins === undefined) return undefined;
  return isPluginArray(plugins) ? undefined : plugins;
}

/**
 * Extract the named-enable list from the `AgentOptions.plugins` union.
 *
 * Both the array (code-`Plugin`) form and the settings-without-`enabled` form
 * yield `[]`. Use this at count/iteration sites; use {@link asPluginsSettings}
 * where `undefined` must stay distinct from `[]`.
 * Code plugins (the array form, or `PluginsSettings.code`) are never counted here, so
 * `pluginCount` and the provider-route checks treat the combined form like the array form.
 *
 * @internal
 */
export function enabledPluginNames(
  plugins: PluginsSettings | readonly Plugin[] | undefined,
): string[] {
  return asPluginsSettings(plugins)?.enabled ?? [];
}
