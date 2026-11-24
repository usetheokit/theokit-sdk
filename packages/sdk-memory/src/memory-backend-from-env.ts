/**
 * `memoryBackendFromEnv` — pick a memory backend from an environment record.
 *
 * Maps a backend name to its adapter package, factory export, API key variable and vendor peer, so
 * an app does not keep its own copy of that table. Adapter packages are imported lazily, only when
 * {@link MemoryBackendChoice.agentOptions} is called, so this adds no hard dependency.
 */

import type { AgentOptions, MemoryProvider, Plugin } from "@theokit/sdk";
import { ConfigurationError } from "@theokit/sdk";

import { createInMemoryMarkdownProvider } from "./in-memory-provider.js";

/**
 * Backend names {@link memoryBackendFromEnv} accepts.
 *
 * @public
 */
export type MemoryBackendName = "builtin" | "mem0" | "honcho" | "supermemory" | "sdk-memory";

/**
 * A selected memory backend.
 *
 * @public
 */
export interface MemoryBackendChoice {
  readonly name: Exclude<MemoryBackendName, "builtin">;
  /** True for a hosted backend: the SDK mirrors facts to it. False for `sdk-memory`. */
  readonly mirrored: boolean;
  /**
   * Agent options that wire the backend (`plugins` for hosted ones, `memoryProvider` for
   * `sdk-memory`). Imports the adapter package on first call; rejects with a
   * `ConfigurationError` naming the missing package or peer.
   */
  agentOptions(): Promise<Partial<AgentOptions>>;
}

/**
 * Options for {@link memoryBackendFromEnv}.
 *
 * @public
 */
export interface MemoryBackendFromEnvOptions {
  /** Variable holding the backend name. Default `THEOKIT_MEMORY_BACKEND`. */
  readonly variable?: string;
  /** Replaces the dynamic `import()`; for tests and bundlers. */
  readonly importer?: (specifier: string) => Promise<unknown>;
}

interface HostedAdapter {
  readonly pkg: string;
  readonly factory: string;
  readonly keyVariable: string;
  readonly peer: string;
}

const HOSTED: Readonly<Record<"mem0" | "honcho" | "supermemory", HostedAdapter>> = {
  mem0: {
    pkg: "@theokit/memory-mem0",
    factory: "mem0Memory",
    keyVariable: "MEM0_API_KEY",
    peer: "mem0ai",
  },
  honcho: {
    pkg: "@theokit/memory-honcho",
    factory: "honchoMemory",
    keyVariable: "HONCHO_API_KEY",
    peer: "@honcho-ai/sdk",
  },
  supermemory: {
    pkg: "@theokit/memory-supermemory",
    factory: "supermemoryMemory",
    keyVariable: "SUPERMEMORY_API_KEY",
    peer: "supermemory",
  },
};

const ACCEPTED: readonly MemoryBackendName[] = [
  "builtin",
  "mem0",
  "honcho",
  "supermemory",
  "sdk-memory",
];

const DEFAULT_VARIABLE = "THEOKIT_MEMORY_BACKEND";

const defaultImporter = (specifier: string): Promise<unknown> => import(specifier);

async function loadHostedPlugin(
  adapter: HostedAdapter,
  apiKey: string,
  importer: (specifier: string) => Promise<unknown>,
): Promise<Plugin> {
  let mod: Record<string, unknown>;
  try {
    mod = (await importer(adapter.pkg)) as Record<string, unknown>;
  } catch (cause) {
    throw new ConfigurationError(
      `Could not load ${adapter.pkg} (needs the peer dependency ${adapter.peer}): install both with \`pnpm add ${adapter.pkg} ${adapter.peer}\`.`,
      { code: "memory_backend_unavailable", cause },
    );
  }
  const factory = mod?.[adapter.factory];
  if (typeof factory !== "function") {
    throw new ConfigurationError(
      `${adapter.pkg} does not export ${adapter.factory}(); check the installed version.`,
      { code: "memory_backend_unavailable" },
    );
  }
  const plugin = (factory as (options: { apiKey: string }) => Plugin)({ apiKey });
  if ((plugin as { kind?: unknown } | undefined)?.kind !== "memory") {
    throw new ConfigurationError(
      `${adapter.pkg}.${adapter.factory}() did not return a plugin of kind "memory".`,
      { code: "memory_backend_unavailable" },
    );
  }
  return plugin;
}

/**
 * Choose a memory backend from `env`.
 *
 * Returns `undefined` when the variable is unset, empty or `builtin`. Throws a
 * `ConfigurationError` for an unknown name (listing the accepted ones) and for a hosted backend
 * whose API key variable is missing.
 *
 * @public
 */
export function memoryBackendFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: MemoryBackendFromEnvOptions = {},
): MemoryBackendChoice | undefined {
  const variable = options.variable ?? DEFAULT_VARIABLE;
  const importer = options.importer ?? defaultImporter;
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === "" || raw === "builtin") return undefined;

  if (raw === "sdk-memory") {
    return {
      name: "sdk-memory",
      mirrored: false,
      agentOptions: async () => ({
        memoryProvider: createInMemoryMarkdownProvider() as MemoryProvider,
      }),
    };
  }
  if (raw !== "mem0" && raw !== "honcho" && raw !== "supermemory") {
    throw new ConfigurationError(
      `${variable}="${raw}" is not a memory backend; accepted: ${ACCEPTED.join(", ")}.`,
      { code: "memory_backend_unknown" },
    );
  }
  const adapter = HOSTED[raw];
  const apiKey = env[adapter.keyVariable]?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new ConfigurationError(
      `${variable}=${raw} needs ${adapter.keyVariable}, which is not set.`,
      { code: "memory_backend_missing_key" },
    );
  }
  return {
    name: raw,
    mirrored: true,
    agentOptions: async () => ({ plugins: [await loadHostedPlugin(adapter, apiKey, importer)] }),
  };
}
