/**
 * A disposer that detaches ONE registration of `handler` from `hook`.
 *
 * Splices by INDEX rather than filtering equal values: the same function may legitimately be attached
 * twice, and a disposer must detach the one it was given. Idempotent, and the guard matters for a
 * case a weaker one misses — re-attaching the SAME function after disposing, where a stale disposer
 * would otherwise find it at index 0 and remove the new registration.
 */
function makeHookDisposer(
  registrations: PluginRegistrations,
  hook: HookName,
  handler: HookHandler,
): PluginHookDisposer {
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    const current = registrations.hooks.get(hook);
    if (current === undefined) return;
    const at = current.indexOf(handler);
    if (at !== -1) current.splice(at, 1);
    if (current.length === 0) registrations.hooks.delete(hook);
  };
}

/**
 * PluginContext implementation + dev-mode seal (T1.2, ADR D99).
 *
 * `createPluginContext()` returns a fresh `{ ctx, registrations }` pair
 * for each plugin. In dev mode (`NODE_ENV !== "production"`) the context
 * is wrapped in a Proxy that throws on `set`/`delete` to catch plugin
 * abuse early. In production the raw impl is returned (zero overhead).
 *
 * @internal
 */

import type { CustomTool } from "../../types/agent.js";
import { diag } from "../diagnostics.js";
import type {
  CommandHandler,
  CommandOptions,
  HookHandler,
  HookName,
  PluginContext,
  PluginHookDisposer,
} from "./types.js";

interface CommandEntry {
  name: string;
  handler: CommandHandler;
  description?: string;
}

interface InjectedMessage {
  content: string;
  role: "user" | "system";
}

export interface PluginRegistrations {
  tools: CustomTool[];
  commands: CommandEntry[];
  hooks: Map<HookName, HookHandler[]>;
  injected: InjectedMessage[];
}

export function createPluginContext(): {
  ctx: PluginContext;
  registrations: PluginRegistrations;
} {
  const registrations: PluginRegistrations = {
    tools: [],
    commands: [],
    hooks: new Map(),
    injected: [],
  };

  const impl: PluginContext = {
    registerTool(tool) {
      registrations.tools.push(tool);
    },
    registerCommand(name, handler, opts: CommandOptions = {}) {
      const entry: CommandEntry = { name, handler };
      if (opts.description !== undefined) entry.description = opts.description;
      registrations.commands.push(entry);
    },
    // Overloaded in the public type; storage is heterogeneous, so the handler is erased to the
    // internal `HookHandler` (the dispatcher casts it back to the right shape per hook).
    on(hook: HookName, handler: unknown) {
      // EC-2 fix: defense-in-depth. Plugin author can bypass TS via `as any`
      // and pass null/undefined; ignore + warn rather than crash the loop
      // downstream when `runPreToolCallHooks` tries to invoke the handler.
      if (typeof handler !== "function") {
        diag(`[theokit-sdk] ignoring non-function handler for hook "${hook}"\n`);
        // A no-op disposer rather than `undefined`: the caller should not have to know whether the
        // registration was accepted in order to write `const off = ctx.on(...)`.
        return () => undefined;
      }
      const existing = registrations.hooks.get(hook) ?? [];
      existing.push(handler as HookHandler);
      registrations.hooks.set(hook, existing);

      return makeHookDisposer(registrations, hook, handler as HookHandler);
    },
    injectMessage(content, role = "user") {
      registrations.injected.push({ content, role });
    },
  };

  const ctx = shouldSeal() ? sealContext(impl) : impl;
  return { ctx, registrations };
}

function shouldSeal(): boolean {
  return process.env.NODE_ENV !== "production";
}

function sealContext(impl: PluginContext): PluginContext {
  return new Proxy(impl, {
    set(_target, prop) {
      throw new Error(
        `[theokit-sdk] PluginContext is sealed — cannot set ${String(prop)}. ` +
          `Plugins must use registerTool, registerCommand, on, or injectMessage.`,
      );
    },
    deleteProperty(_target, prop) {
      throw new Error(`[theokit-sdk] PluginContext is sealed — cannot delete ${String(prop)}.`);
    },
  });
}
