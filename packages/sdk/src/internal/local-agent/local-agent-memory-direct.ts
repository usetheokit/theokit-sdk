/**
 * `agent.memory` direct API implementation (T2.2, ADR D141 / D142).
 *
 * Builds an `AgentMemory` impl over whichever third-party adapters
 * the `PluginManager` aggregated. Lazy-resolves the adapter list on
 * first access (EC-I: `initialize()` fires exactly once on first
 * write/recall). Multi-adapter fan-out for writes; merge + dedupe by
 * content for recalls.
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
import type { AgentOptions } from "../../types/agent.js";
import type {
  AgentMemory,
  MemoryAdapter,
  MemoryContext,
  MemoryFact,
  MemoryId,
  MemoryTurnMessage,
} from "../../types/memory-adapter.js";
import { diag } from "../diagnostics.js";
import { registerReviewQueue, type TurnReviewQueue } from "../memory/turn-review.js";
import { createMemoryMirror, type MemoryMirror } from "../memory/mirror.js";
import type { PluginManager } from "../plugins/manager.js";

export interface ResolvedAdapters {
  adapters: ReadonlyArray<MemoryAdapter>;
  initialized: boolean;
  /** How many memory plugins were registered, before `isAvailable()` filtered them (#360). */
  registered: number;
}

/**
 * Instantiate each registered memory plugin's adapter, keeping only the ones that report
 * themselves available.
 *
 * #360 — `isAvailable()` is mandatory on `MemoryAdapter` and was consulted by nobody. Every
 * third-party adapter implements it as "is there a non-empty apiKey", so an implementer reasonably
 * reads `false` as "disable me" — and it disabled nothing: the client is built lazily, so a missing
 * key surfaced mid-conversation as `auth_failed`, at the point where a memory write is happening
 * rather than where the operator could still fix it.
 *
 * Skipping degrades to no-memory instead, which is the right shape for an optional capability, and
 * gives a multi-adapter setup a fallback. The diagnostic names the adapter, because a memory that
 * silently does nothing is the failure this exists to replace.
 */
async function createAvailableAdapters(
  entries: ReadonlyArray<{
    pluginName: string;
    createProvider: (cwd: string) => Promise<MemoryAdapter> | MemoryAdapter;
  }>,
  workspaceCwd: string,
): Promise<MemoryAdapter[]> {
  const available: MemoryAdapter[] = [];
  for (const entry of entries) {
    const instance = await entry.createProvider(workspaceCwd);
    if (instance.isAvailable() === false) {
      diag(
        `[theokit-sdk] memory adapter "${instance.id}" reports itself unavailable ` +
          `(plugin "${entry.pluginName}") — skipping it. Check its credentials.\n`,
      );
      continue;
    }
    available.push(instance);
  }
  return available;
}

/** @internal */
export interface AdapterResolver {
  /** Resolve (once, concurrency-safe) and initialize the registered adapters. */
  ensure(): Promise<ResolvedAdapters>;
  /** The adapters if `ensure()` already resolved, else `undefined`. */
  peek(): ResolvedAdapters | undefined;
}

/**
 * Lazy, shared adapter resolution: `initialize()` fires once per adapter even when the direct API
 * and the memory mirror ask at the same time. A failed resolution is not cached.
 *
 * @internal
 */
export function createAdapterResolver(
  pluginManager: PluginManager,
  workspaceCwd: string,
): AdapterResolver {
  let resolved: ResolvedAdapters | undefined;
  let pending: Promise<ResolvedAdapters> | undefined;

  async function resolve(): Promise<ResolvedAdapters> {
    const entries = pluginManager.aggregated.memoryProviders;
    const created = await createAvailableAdapters(entries, workspaceCwd);
    // EC-I: initialize() each adapter exactly once on first access.
    for (const adapter of created) {
      if (adapter.initialize !== undefined) {
        await adapter.initialize();
      }
    }
    resolved = { adapters: created, initialized: true, registered: entries.length };
    return resolved;
  }

  return {
    ensure(): Promise<ResolvedAdapters> {
      if (resolved !== undefined) return Promise.resolve(resolved);
      pending ??= resolve().catch((cause: unknown) => {
        pending = undefined;
        throw cause;
      });
      return pending;
    },
    peek: () => resolved,
  };
}

/**
 * Build a lazy `AgentMemory` accessor over the plugin-aggregated
 * memory adapters. Returns `null` when no `kind: "memory"` plugin
 * is registered — callers branch on `adapter() === null`.
 *
 * @internal
 */
export function buildAgentMemory(
  pluginManager: PluginManager,
  workspaceCwd: string,
  defaultContext: MemoryContext | undefined,
  resolver: AdapterResolver = createAdapterResolver(pluginManager, workspaceCwd),
  reviewQueue?: TurnReviewQueue,
): AgentMemory {
  async function ensure(): Promise<ResolvedAdapters> {
    return resolver.ensure();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 6 optional fields × per-field caller-wins-over-default merge is a flat ladder; extracting helpers fragments the EC-P invariant.
  function mergeContext(partial: Partial<MemoryContext> | undefined): MemoryContext {
    // EC-P: caller's ctx.userId always wins over agent default.
    const merged: MemoryContext = {
      userId: partial?.userId ?? defaultContext?.userId ?? "",
      ...(partial?.agentId !== undefined
        ? { agentId: partial.agentId }
        : defaultContext?.agentId !== undefined
          ? { agentId: defaultContext.agentId }
          : {}),
      ...(partial?.sessionId !== undefined
        ? { sessionId: partial.sessionId }
        : defaultContext?.sessionId !== undefined
          ? { sessionId: defaultContext.sessionId }
          : {}),
      ...(partial?.tenantId !== undefined
        ? { tenantId: partial.tenantId }
        : defaultContext?.tenantId !== undefined
          ? { tenantId: defaultContext.tenantId }
          : {}),
      ...(partial?.tags !== undefined
        ? { tags: partial.tags }
        : defaultContext?.tags !== undefined
          ? { tags: defaultContext.tags }
          : {}),
      ...(partial?.metadata !== undefined
        ? { metadata: partial.metadata }
        : defaultContext?.metadata !== undefined
          ? { metadata: defaultContext.metadata }
          : {}),
    };
    if (merged.userId === "") {
      throw new ConfigurationError(
        "agent.memory requires a userId — either set AgentOptions.memoryContext.userId or pass ctx.userId at call time.",
        { code: "memory_context_missing_user_id" },
      );
    }
    return merged;
  }

  async function requireAdapters(): Promise<ReadonlyArray<MemoryAdapter>> {
    const r = await ensure();
    if (r.adapters.length === 0) {
      // Two different facts, and telling them apart is the difference between "add a plugin" and
      // "fix the key on the plugin you already added" (#360).
      throw new ConfigurationError(
        r.registered === 0
          ? "No memory adapter registered. Pass a memory plugin in AgentOptions.plugins (e.g. supermemoryMemory({...}))."
          : `All ${r.registered} registered memory adapter(s) reported themselves unavailable — see the warnings naming each one. Check their credentials.`,
        { code: "no_memory_adapter" },
      );
    }
    return r.adapters;
  }

  const memory: AgentMemory = {
    async write(
      content: string | MemoryTurnMessage[],
      ctx?: Partial<MemoryContext>,
    ): Promise<MemoryId> {
      const adapters = await requireAdapters();
      const merged = mergeContext(ctx);
      // Fan-out: write to all. Return the first id; collect errors per adapter.
      const writes = await Promise.allSettled(adapters.map((a) => a.write(content, merged)));
      const firstFulfilled = writes.find((r) => r.status === "fulfilled");
      if (firstFulfilled === undefined) {
        // All adapters failed — surface the first error.
        const firstReason = writes[0] as PromiseRejectedResult;
        throw firstReason.reason;
      }
      return (firstFulfilled as PromiseFulfilledResult<MemoryId>).value;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: settled-promise iteration + content dedupe + graceful degrade are 3 inline concerns; helpers would obscure the merge invariant.
    async recall(query: string, ctx?: Partial<MemoryContext>, k?: number): Promise<MemoryFact[]> {
      const adapters = await requireAdapters();
      const merged = mergeContext(ctx);
      // Merge + dedupe by content. Per-adapter failures degrade gracefully:
      // the caller still gets results from healthy adapters.
      const recalls = await Promise.allSettled(adapters.map((a) => a.recall(query, merged, k)));
      const out: MemoryFact[] = [];
      const seen = new Set<string>();
      for (const r of recalls) {
        if (r.status !== "fulfilled") continue;
        for (const fact of r.value) {
          if (seen.has(fact.content)) continue;
          seen.add(fact.content);
          out.push(fact);
        }
      }
      return out;
    },

    async delete(id: MemoryId): Promise<void> {
      const adapters = await requireAdapters();
      // Route by id prefix: the adapter whose id matches the MemoryId prefix.
      const prefix = id.split(":", 1)[0] ?? "";
      const target = adapters.find((a) => a.id === prefix);
      if (target === undefined) {
        throw new ConfigurationError(
          `No adapter found for MemoryId prefix "${prefix}" (registered: ${adapters.map((a) => a.id).join(", ")}).`,
          { code: "no_memory_adapter" },
        );
      }
      await target.delete(id);
    },

    reviewsIdle: () => reviewQueue?.idle() ?? Promise.resolve(),

    adapter(): MemoryAdapter | null {
      // Synchronous — only useful AFTER `ensure()` resolved at least once.
      // Callers that want adapter introspection should `await agent.memory.write/recall`
      // first to trigger initialization.
      const resolved = resolver.peek();
      if (resolved === undefined) return null;
      return resolved.adapters[0] ?? null;
    },
  };
  registerReviewQueue(memory, reviewQueue);
  return memory;
}

/**
 * Build the `agent.memory` accessor and, when `memory.mirror` is set, the built-in-store mirror,
 * over one shared adapter resolver so each adapter is initialized once.
 *
 * @internal
 */
export function wireAgentMemory(
  pluginManager: PluginManager,
  workspaceCwd: string,
  options: AgentOptions,
  reviewQueue?: TurnReviewQueue,
): [AgentMemory, MemoryMirror | undefined] {
  const resolver = createAdapterResolver(pluginManager, workspaceCwd);
  const memory = buildAgentMemory(pluginManager, workspaceCwd, options.memoryContext, resolver, reviewQueue);
  const settings = options.memory;
  if (settings?.enabled !== true || settings.mirror === undefined) return [memory, undefined];
  const mirror = createMemoryMirror({
    options: settings.mirror,
    adapters: async () => (await resolver.ensure()).adapters,
    context: () => {
      const userId = options.memoryContext?.userId ?? settings.userId;
      if (userId === undefined || userId === "") return undefined;
      return { ...options.memoryContext, userId };
    },
  });
  return [memory, mirror];
}
