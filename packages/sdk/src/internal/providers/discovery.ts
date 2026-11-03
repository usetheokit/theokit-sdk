/**
 * Lazy provider discovery (T3.4, ADR D107).
 *
 * Scans `~/.theokit/plugins/model-providers/<name>/index.{js,mjs}` and
 * imports each as a Plugin. Plugins with `kind: "model-provider"` register
 * their profile. Errors per plugin are logged + skipped. Each plugin is
 * imported at most once per process; the trust gate is read on every call.
 *
 * EC-9: dynamic `import()` in Node 22 needs `file://` URL for absolute
 * paths in ESM contexts. `pathToFileURL` handles both.
 *
 * @internal
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { diag } from "../diagnostics.js";
import { globalSingleton } from "../global-singleton.js";
import { registerProvider } from "./registry.js";
import { readTrustedNames, trustFilePath } from "./trust-gate.js";

// M47 review F3 — the state lives on `globalThis` via `Symbol.for`, mirroring registry.ts's
// M44 B1 pattern: tsup bundles each entry (`dist/index.js`, `dist/cron.js`, …) with its OWN module copy,
// so module-local sets would re-import a provider once per entry (duplicate I/O + spurious
// "Provider overridden" WARNs). Every bundle copy shares THIS state.
//
// B-686 — per-name sets, not a process latch: the root and the trust gate are read on every call, so a
// name trusted between two `Agent.create` calls is imported by the second. `loaded` keeps M47's
// "imported at most once" (a name is attempted once, success or failure); `warned` keeps the untrusted
// warning to one per name.
const discoveryState = globalSingleton("theokit-sdk.providers.discovered", () => ({
  loaded: new Set<string>(),
  warned: new Set<string>(),
}));

function pluginsRoot(): string {
  return join(homedir(), ".theokit", "plugins", "model-providers");
}

export async function discoverProviderPlugins(): Promise<void> {
  const root = pluginsRoot();
  if (!existsSync(root)) return;

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }

  const trusted = readTrustedNames();
  for (const entry of entries) {
    if (discoveryState.loaded.has(entry)) continue;
    // M47 — the gate fires BEFORE any import(): untrusted code is never evaluated (import-time side effects
    // ARE the attack; a post-import check would be theater).
    if (!trusted.has(entry)) {
      warnUntrusted(entry);
      continue;
    }
    // Added before the await: a concurrent create sees the name as taken and skips it.
    discoveryState.loaded.add(entry);
    await loadOne(join(root, entry), entry);
  }
}

function warnUntrusted(entry: string): void {
  if (discoveryState.warned.has(entry)) return;
  discoveryState.warned.add(entry);
  // M47 review F4/F7 — the remedy must be complete, and the env format is comma-separated. The gate is
  // read on every create (B-686), so no restart is needed.
  diag(
    `[theokit-sdk] WARN: provider plugin "${entry}" is present but NOT trusted — skipped. ` +
      `To trust it, add "${entry}" to ${trustFilePath()} (JSON array of names) or ` +
      `THEOKIT_TRUSTED_PROVIDERS (comma-separated).\n`,
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 2-extension loader (mjs / js) + plugin shape detection (default / named / direct) — inlining is clearer than 5 helper fns.
async function loadOne(dir: string, entryName: string): Promise<void> {
  for (const ext of ["index.mjs", "index.js"]) {
    const indexPath = join(dir, ext);
    if (!existsSync(indexPath)) continue;
    try {
      const mod = await import(pathToFileURL(indexPath).href);
      const plugin = mod.default ?? mod[entryName] ?? mod;
      if (
        plugin !== null &&
        typeof plugin === "object" &&
        (plugin as { kind?: unknown }).kind === "model-provider"
      ) {
        const profile = (plugin as { profile?: unknown }).profile;
        if (profile !== undefined && typeof profile === "object") {
          registerProvider(profile as Parameters<typeof registerProvider>[0]);
        }
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diag(`[theokit-sdk] failed to load provider plugin "${entryName}": ${msg}\n`);
      return;
    }
  }
}

/** Test-only reset. @internal */
export function _resetDiscovery(): void {
  discoveryState.loaded.clear();
  discoveryState.warned.clear();
}
