/**
 * PluginManager — constructs PluginContext per plugin, invokes register()
 * once, aggregates registrations + provider profiles + memory factories
 * (T1.3, ADRs D97-D101).
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
// SE45/SE46 — `MemoryProviderFactory` (@internal) is imported from the contract
// module directly; the `./types.js` shim deliberately does not re-export it (a
// stripped-internal re-export trips rollup-plugin-dts). See ./types.ts.
import type { MemoryProviderFactory } from "../../types/plugin.js";
import { diag } from "../diagnostics.js";
import type { ProviderProfile } from "../providers/types.js";
import { createPluginContext, type PluginRegistrations } from "./context.js";
import type {
  HookHandler,
  HookName,
  LlmCallContext,
  Plugin,
  PostAssistantReplyContext,
  PostToolCallContext,
  PreToolCallContext,
  PreToolCallDecision,
  PreUserSendContext,
  PreUserSendResult,
  SessionLifecycleContext,
  ToolResultTransformContext,
  TransformContext,
} from "./types.js";

export interface ProviderEntry {
  pluginName: string;
  profile: ProviderProfile;
}

export interface MemoryEntry {
  pluginName: string;
  createProvider: MemoryProviderFactory;
}

export interface AggregatedPlugins {
  tools: PluginRegistrations["tools"];
  commands: PluginRegistrations["commands"];
  hooks: PluginRegistrations["hooks"];
  injected: PluginRegistrations["injected"];
  providerProfiles: ProviderEntry[];
  memoryProviders: MemoryEntry[];
}

export class PluginManager {
  #aggregated: AggregatedPlugins = {
    tools: [],
    commands: [],
    hooks: new Map(),
    injected: [],
    providerProfiles: [],
    memoryProviders: [],
  };
  #initialized = false;
  // #68 — registrations of plugins added post-init via `register()`, keyed by
  // plugin name so a re-register REPLACES (not appends) the prior hooks.
  readonly #byName = new Map<string, PluginRegistrations>();

  async initialize(plugins: ReadonlyArray<Plugin>): Promise<void> {
    if (this.#initialized) {
      throw new Error("PluginManager.initialize called twice — register only once per process");
    }
    this.#initialized = true;
    // EC-4: surface duplicate plugin names so operators notice. Two plugins
    // with the same name are usually a mistake (npm install with override).
    const seen = new Set<string>();
    for (const plugin of plugins) {
      if (seen.has(plugin.name)) {
        diag(
          `[theokit-sdk] duplicate plugin name "${plugin.name}" — both will register independently\n`,
        );
      }
      seen.add(plugin.name);
      await this.#dispatchPlugin(plugin);
    }
  }

  /**
   * #68 — register a single `general` plugin AFTER `initialize()` has run.
   *
   * The bulk `initialize()` is single-shot (one call per process); late
   * registration is a distinct, named operation used by adapters that install
   * a plugin per-session/per-request (e.g. the ACP permission veto, which is
   * installed once the permission mode + connection are known — after the
   * agent's own plugins were already initialized).
   *
   * Idempotent by plugin NAME: re-registering a plugin with the same name
   * REPLACES its prior hooks/tools instead of appending duplicates (the ACP
   * permission plugin is re-installed on every prompt).
   *
   * Only `general` plugins may be registered late — model-provider / memory
   * plugins are resolved during the bulk init and cannot be added afterwards.
   */
  async register(plugin: Plugin): Promise<void> {
    if (plugin.kind !== "general") {
      throw new ConfigurationError(
        `late register supports general plugins only (got "${plugin.kind}" for "${plugin.name}")`,
        { code: "plugin_late_register_kind" },
      );
    }
    const prior = this.#byName.get(plugin.name);
    if (prior !== undefined) this.#unmerge(prior);
    const { ctx, registrations } = createPluginContext();
    await plugin.register(ctx);
    this.#byName.set(plugin.name, registrations);
    this.#merge(registrations);
  }

  get aggregated(): Readonly<AggregatedPlugins> {
    return this.#aggregated;
  }

  /**
   * Run all `pre_tool_call` hooks; first decision with `block: true` wins.
   * D101: veto pattern — return `{ block: true, message }` makes the loop
   * surface a tool_result with `isError: false, content: message` so the
   * LLM can self-correct.
   */
  async runPreToolCallHooks(ctx: PreToolCallContext): Promise<PreToolCallDecision | undefined> {
    const handlers = this.#aggregated.hooks.get("pre_tool_call") ?? [];
    let deferred: PreToolCallDecision | undefined;
    for (const h of handlers) {
      const decision = (await (h as (c: PreToolCallContext) => unknown)(ctx)) as
        | PreToolCallDecision
        | undefined;
      if (decision === undefined) continue;
      if ((decision as { block?: boolean }).block === true) return decision;
      // A block from a later handler still wins over an earlier defer.
      if ((decision as { defer?: boolean }).defer === true) deferred ??= decision;
    }
    return deferred;
  }

  /** Aggregated handlers for a given hook (read-only view). @internal */
  hooksFor(name: Parameters<AggregatedPlugins["hooks"]["get"]>[0]): ReadonlyArray<HookHandler> {
    return this.#aggregated.hooks.get(name) ?? [];
  }

  /**
   * Run all `pre_user_send` hooks; concatenate non-empty `recalledContext`
   * outputs with `\n\n` and cap total length at `maxRecallContextBytes`
   * (EC-A). Per-handler failures are caught + logged to stderr (EC-8) so a
   * single broken adapter never blocks the LLM call (graceful degrade).
   *
   * Returns the assembled context (or undefined if empty after cap).
   *
   * @internal
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-handler try/catch + EC-A cap + EC-8 isolation are 3 concerns that share state (parts buffer); splitting fragments the single-pass aggregation.
  async runPreUserSendHooks(
    ctx: PreUserSendContext,
    maxRecallContextBytes: number,
  ): Promise<string | undefined> {
    const handlers = this.#aggregated.hooks.get("pre_user_send") ?? [];
    if (handlers.length === 0) return undefined;
    const parts: string[] = [];
    for (const h of handlers) {
      try {
        const result = (await (h as (c: PreUserSendContext) => unknown)(ctx)) as
          | PreUserSendResult
          | undefined;
        if (result?.recalledContext && result.recalledContext.length > 0) {
          parts.push(result.recalledContext);
        }
      } catch (err) {
        diag(
          `[theokit-sdk] pre_user_send hook failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
    if (parts.length === 0) return undefined;
    let combined = parts.join("\n\n");
    // EC-A: cap to prevent context-window blowout.
    if (combined.length > maxRecallContextBytes) {
      combined = `${combined.slice(0, maxRecallContextBytes)}\n…[truncated]`;
    }
    return combined;
  }

  /**
   * Run all `post_assistant_reply` hooks. Fire-and-forget: errors are
   * surfaced to stderr (EC-O) so a slow/broken sync never blocks the
   * caller's `wait()`. Returns a Promise that callers may optionally
   * await for tests; production code typically `void`s it.
   *
   * @internal
   */
  async runPostAssistantReplyHooks(ctx: PostAssistantReplyContext): Promise<void> {
    const handlers = this.#aggregated.hooks.get("post_assistant_reply") ?? [];
    for (const h of handlers) {
      try {
        await (h as (c: PostAssistantReplyContext) => unknown)(ctx);
      } catch (err) {
        diag(
          `[theokit-sdk] post_assistant_reply hook failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  // #65 — the previously-dead hooks, now wired. Fire-and-forget hooks run
  // in order (per-handler errors logged, never thrown); transform hooks fold
  // over the payload (a handler returning a value replaces it).

  /** @internal */
  async #runFireAndForget<C>(name: HookName, ctx: C): Promise<void> {
    for (const h of this.#aggregated.hooks.get(name) ?? []) {
      try {
        await (h as (c: C) => unknown)(ctx);
      } catch (err) {
        diag(
          `[theokit-sdk] ${name} hook failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /** @internal — fold: each handler may return a replacement payload; a throw keeps the prior value. */
  async #runTransform<P>(name: HookName, payload: P, ctx: unknown): Promise<P> {
    let current = payload;
    for (const h of this.#aggregated.hooks.get(name) ?? []) {
      try {
        const out = (await (h as (p: P, c: unknown) => unknown)(current, ctx)) as P | undefined;
        if (out !== undefined) current = out;
      } catch (err) {
        diag(
          `[theokit-sdk] ${name} hook failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return current;
  }

  /** #65 — fired after a tool call completes. @internal */
  runPostToolCallHooks(ctx: PostToolCallContext): Promise<void> {
    return this.#runFireAndForget("post_tool_call", ctx);
  }

  /** #65 — fired before / after each LLM turn. @internal */
  runPreLlmCallHooks(ctx: LlmCallContext): Promise<void> {
    return this.#runFireAndForget("pre_llm_call", ctx);
  }
  runPostLlmCallHooks(ctx: LlmCallContext): Promise<void> {
    return this.#runFireAndForget("post_llm_call", ctx);
  }

  /** #65 — fired at run start / end. @internal */
  runOnSessionStartHooks(ctx: SessionLifecycleContext): Promise<void> {
    return this.#runFireAndForget("on_session_start", ctx);
  }
  runOnSessionEndHooks(ctx: SessionLifecycleContext): Promise<void> {
    return this.#runFireAndForget("on_session_end", ctx);
  }

  /** #65/#57 — transform tool results before they reach the LLM (the #57 seam). @internal */
  runTransformToolResultHooks<T>(results: T, ctx: ToolResultTransformContext): Promise<T> {
    return this.#runTransform("transform_tool_result", results, ctx);
  }

  /** #65 — transform the LLM output text before it is consumed. @internal */
  runTransformLlmOutputHooks(output: string, ctx: TransformContext): Promise<string> {
    return this.#runTransform("transform_llm_output", output, ctx);
  }

  async #dispatchPlugin(plugin: Plugin): Promise<void> {
    if (plugin.kind === "general") {
      const { ctx, registrations } = createPluginContext();
      await plugin.register(ctx);
      this.#merge(registrations);
    } else if (plugin.kind === "model-provider") {
      this.#aggregated.providerProfiles.push({
        pluginName: plugin.name,
        profile: plugin.profile,
      });
    } else if (plugin.kind === "memory") {
      this.#aggregated.memoryProviders.push({
        pluginName: plugin.name,
        createProvider: plugin.createProvider,
      });
    }
  }

  #merge(r: PluginRegistrations): void {
    this.#aggregated.tools.push(...r.tools);
    this.#aggregated.commands.push(...r.commands);
    for (const [hook, handlers] of r.hooks.entries()) {
      const existing = this.#aggregated.hooks.get(hook) ?? [];
      existing.push(...handlers);
      this.#aggregated.hooks.set(hook, existing);
    }
    this.#aggregated.injected.push(...r.injected);
  }

  /**
   * #68 — inverse of #merge: remove a prior registration's contributions from
   * the aggregated view by object identity. Used by `register()` to replace a
   * same-named plugin's hooks/tools instead of accumulating duplicates.
   */
  #unmerge(r: PluginRegistrations): void {
    removeAll(this.#aggregated.tools, r.tools);
    removeAll(this.#aggregated.commands, r.commands);
    removeAll(this.#aggregated.injected, r.injected);
    for (const [hook, handlers] of r.hooks.entries()) {
      const existing = this.#aggregated.hooks.get(hook);
      if (existing === undefined) continue;
      removeAll(existing, handlers);
      if (existing.length === 0) this.#aggregated.hooks.delete(hook);
    }
  }
}

/** Remove each element of `toRemove` from `arr` in place (by identity). */
function removeAll<T>(arr: T[], toRemove: ReadonlyArray<T>): void {
  for (const item of toRemove) {
    const idx = arr.indexOf(item);
    if (idx !== -1) arr.splice(idx, 1);
  }
}
