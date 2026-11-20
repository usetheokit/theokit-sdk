/**
 * Plugin contract — RUNTIME value + type re-exports (T1.1, ADRs D97-D101).
 *
 * SE45/SE46 — the pure `Plugin` *type* and its type companions now live in
 * `types/plugin.ts` (above the DIP boundary, because `Plugin` is public
 * contract). This module keeps the RUNTIME value (`definePlugin` /
 * `Plugin.create`) and re-exports the types so every existing
 * `../plugins/types.js` importer (and the `index.ts` barrel) resolves the same
 * names unchanged.
 *
 * @public
 */

import type { Plugin as PluginType } from "../../types/plugin.js";

export type {
  CommandHandler,
  CommandOptions,
  ConversationRef,
  GeneralPlugin,
  HookContextMap,
  HookHandler,
  HookName,
  HookResultMap,
  LlmCallContext,
  // #335 — this used to be omitted here, with the note that it "stays reachable as
  // the `createProvider` field type on the `Plugin` union, which IS re-exported".
  // That inference was false, and it is what shipped a broken declaration: the DTS
  // rollup emits an exported type's BODY and treeshakes away a non-exported type
  // that body merely NAMES. Reachable-as-a-field-type is not reachable-as-a-
  // declaration. The published `.d.ts` said `createProvider: MemoryProviderFactory`
  // with no such type in the file — invisible under `skipLibCheck`, and an
  // `error`-typed graph for any consumer running type-aware lint.
  //
  // The original reason for the omission (re-exporting a decl that carries the
  // internal-visibility JSDoc tag leaves a dangling re-export once `stripInternal`
  // deletes it) no longer applies: the tag came off `types/plugin.ts`, because a
  // type named by a public signature is public. That tag is matched as TEXT, so
  // its literal spelling is deliberately absent from this comment too.
  MemoryProviderFactory,
  PluginContext,
  PluginHookDisposer,
  PostAssistantReplyContext,
  PostToolCallContext,
  PreToolCallContext,
  PreToolCallDecision,
  PreUserSendContext,
  PreUserSendResult,
  SessionLifecycleContext,
  ToolCallSummary,
  ToolContext,
  ToolResultTransformContext,
  TransformContext,
  TypedHookHandler,
} from "../../types/plugin.js";

// Re-establish the declaration merge locally: `Plugin` is BOTH the discriminated
// union *type* (aliased from ./types/plugin.js) AND the runtime const-companion
// (`Plugin.create`) declared below. Keeping both bindings under the one exported
// name `Plugin` preserves the public value+type surface byte-for-byte.
export type Plugin = PluginType;

/**
 * Identity helper for plugin authors. TS-only convenience — preserves
 * inferred type without forcing manual `Plugin` annotation.
 *
 * @public
 */
export function definePlugin<P extends Plugin>(p: P): P {
  return p;
}

/** SE36 — `Plugin.create` replaces `definePlugin` (ADR 0015). Const-companion (the `Plugin` type alias blocks a class of the same name); `create` is the generic `definePlugin`. @public */
export const Plugin = { create: definePlugin };
