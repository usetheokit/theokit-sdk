/**
 * Fork agent primitive (T1.2, ADRs D110-D114).
 *
 * `forkAgentImpl(parent, options, deps)` creates a short-lived auxiliary
 * agent that inherits the parent's credentials and **byte-identical**
 * system prompt (D112 — cache hit) but runs with a reduced tool
 * whitelist enforced via `AsyncLocalStorage` (D111). Memory plugins
 * (`kind: "memory"`) are preserved so memory writes carry provenance
 * (D114 + EC-B fix); general/model-provider plugins are dropped because
 * the fork has its own `PluginManager.initialize` and double-registering
 * is redundant.
 *
 * @internal
 */

import type { AgentOptions, SDKAgent } from "../../../types/agent.js";
// ForkOptions/ForkResult live in the leaf `types/fork.ts` (arch-review ADR 0001)
// so `types/agent.ts` can reference them without importing this implementation
// module (which would form a type-only cycle). Re-exported here for back-compat.
import type { ForkOptions, ForkResult } from "../../../types/fork.js";
import { withToolWhitelist } from "../../concurrency/async-local-storage.js";
import { isCodePlugin } from "../../plugins/plugin-guards.js";
import type { Plugin } from "../../plugins/types.js";

export type { ForkOptions, ForkResult } from "../../../types/fork.js";

/**
 * Injected dependency contract — keeps fork-agent acyclic with `Agent`.
 *
 * @internal
 */
export interface ForkDeps {
  create: (options: AgentOptions) => Promise<SDKAgent>;
}

/**
 * Parent shape required by the fork. Any `SDKAgent` plus a `readonly options`
 * accessor (LocalAgent exposes it via the public getter added in T4.3).
 *
 * @internal
 */
export interface ForkParent {
  readonly agentId: string;
  readonly options: AgentOptions;
}

/**
 * Preserve memory plugins (kind: "memory") so the fork can write memory
 * with provenance (D114). Drop other kinds — the fork's own
 * `PluginManager` will re-initialize from `forkOptions.plugins`, and
 * general/model-provider re-registration is redundant.
 *
 * EC-B (edge-case review): without this filter, every fork would lose
 * memory writeability when callers use the v1.3 `plugins: Plugin[]`
 * shape (D98).
 *
 * @internal
 */
export function filterMemoryPlugins(
  plugins: unknown,
): Array<Extract<Plugin, { kind: "memory" }>> | undefined {
  if (!Array.isArray(plugins)) return undefined;
  const memoryOnly = plugins.filter(
    (p): p is Extract<Plugin, { kind: "memory" }> => isCodePlugin(p) && p.kind === "memory",
  );
  return memoryOnly.length > 0 ? memoryOnly : undefined;
}

/**
 * Run a forked sub-agent. Inherits parent credentials and system prompt
 * byte-identical (D112), enforces `allowedTools` via AsyncLocalStorage
 * (D111), disposes the auxiliary agent in `finally` regardless of outcome.
 *
 * @internal
 */
export async function forkAgentImpl(
  parent: ForkParent,
  options: ForkOptions,
  deps: ForkDeps,
): Promise<ForkResult> {
  const parentOptions = parent.options;
  // EC-B fix: preserve memory plugins so fork can attribute memory writes;
  // drop general/model-provider plugins (redundant per-fork re-init).
  const memoryPlugins = filterMemoryPlugins(parentOptions.plugins as unknown);

  const forkOptions: AgentOptions = {
    ...parentOptions,
    // Strip fields that don't survive fork:
    agentId: undefined,
    skills: undefined,
    // Override:
    plugins: memoryPlugins as unknown as AgentOptions["plugins"],
    systemPrompt:
      options.systemPrompt ??
      (typeof parentOptions.systemPrompt === "string" ? parentOptions.systemPrompt : undefined),
    metadata: {
      ...(parentOptions.metadata ?? {}),
      forkOrigin: options.forkOrigin ?? "fork",
      parentAgentId: parent.agentId,
    },
  };

  const fork = await deps.create(forkOptions);
  try {
    return await withToolWhitelist(options.allowedTools, async () => {
      const run = await fork.send(options.prompt);
      const result = await run.wait();
      return {
        result: result.result,
        toolCalls: [],
        usage: extractUsage(result),
      };
    });
  } finally {
    await fork.dispose();
  }
}

function extractUsage(result: unknown): { inputTokens: number; outputTokens: number } {
  if (typeof result !== "object" || result === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = (result as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const u = usage as { inputTokens?: number; outputTokens?: number };
  return {
    inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : 0,
    outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : 0,
  };
}
