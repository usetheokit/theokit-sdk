/**
 * Run `pre_tool_call` plugins for tool calls an app dispatches outside the agent loop
 * (code-mode scripts, an MCP endpoint, a relay).
 */

import { ToolCallBlockedError } from "./errors.js";
import { PluginManager } from "./internal/plugins/manager.js";
import type { Plugin, PreToolCallContext, PreToolCallDecision } from "./internal/plugins/types.js";
import type { CustomTool, PermissionMode } from "./types/agent-prims.js";

/**
 * Run the `pre_tool_call` chain of `plugins` for one call. The first decision with `block: true`
 * wins and later handlers are not called; `undefined` means every plugin allowed the call.
 *
 * A handler that throws is NOT converted to a veto: the exception propagates and this promise
 * rejects with it, exactly as in the agent loop's tool dispatch.
 *
 * @public
 */
export async function runPreToolCall(
  plugins: readonly Plugin[],
  ctx: PreToolCallContext,
): Promise<PreToolCallDecision | undefined> {
  const manager = new PluginManager();
  await manager.initialize(plugins);
  return manager.runPreToolCallHooks(ctx);
}

/**
 * Identity of the run a guarded tool call belongs to.
 *
 * @public
 */
export interface GuardToolsContext {
  agentId: string;
  /** Called per call; default a fresh id per call. */
  runId?: () => string;
  permissionMode?: PermissionMode;
}

/**
 * Wrap each tool so its handler runs the `pre_tool_call` chain first. A veto rejects with
 * {@link ToolCallBlockedError} and the handler is not called. A plugin handler that throws
 * propagates its exception (as in the agent loop). Name, description and schema are unchanged.
 * The plugins are registered once, on the first call. The context carries no conversation; use
 * `runPreToolCall` directly to pass one.
 *
 * @public
 */
export function guardTools(
  tools: readonly CustomTool[],
  plugins: readonly Plugin[],
  ctx: GuardToolsContext,
): CustomTool[] {
  const manager = new PluginManager();
  let ready: Promise<void> | undefined;
  const init = (): Promise<void> => {
    ready ??= manager.initialize(plugins);
    return ready;
  };
  let counter = 0;
  const nextRunId = ctx.runId ?? (() => `guard-${Date.now().toString(36)}-${++counter}`);
  return tools.map((tool) => ({
    ...tool,
    handler: async (input, toolCtx) => {
      await init();
      const decision = await manager.runPreToolCallHooks({
        name: tool.name,
        args: input,
        agentId: ctx.agentId,
        runId: nextRunId(),
        ...(ctx.permissionMode !== undefined ? { permissionMode: ctx.permissionMode } : {}),
      });
      if (decision !== undefined) throw new ToolCallBlockedError(tool.name, blockMessage(decision));
      return tool.handler(input, toolCtx);
    },
  }));
}

/** No run loop here to end on a deferred call, so a defer blocks the call. */
function blockMessage(decision: PreToolCallDecision): string {
  return "defer" in decision ? (decision.reason ?? "deferred") : decision.message;
}
