/**
 * ACP tool permission plugin — bridges ACP `requestPermission` to our SDK
 * `pre_tool_call` veto hook (D101, D355, EC-2).
 *
 * Modes:
 *  - `auto`  — pass-through; `installPermissionPlugin` is never called, so `trustedTools` and
 *              `timeoutMs` have no effect
 *  - `deny`  — block every tool call, INCLUDING the ones in `trustedTools` (the deny branch is
 *              evaluated first)
 *  - `ask`   — round-trip via `conn.requestPermission`, with `trustedTools` skipping the round-trip
 *              and `timeoutMs` bounding it (EC-2)
 *
 * Every failure of the round-trip blocks: timeout, host-side cancel, an explicit deny, and a
 * transport error are all vetoes. The tool never runs on ambiguity.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { ConfigurationError, Plugin, type AgentLike } from "@theokit/sdk";
import { toolKind } from "./translator.js";
import type { PermissionMode } from "./types.js";

interface PermissionPluginArgs {
  conn: acp.AgentSideConnection;
  sessionId: string;
  mode: PermissionMode;
  trustedTools: Set<string>;
  timeoutMs: number;
}

interface VetoDecision {
  block: true;
  message: string;
}

async function askWithTimeout(
  args: PermissionPluginArgs,
  toolName: string,
): Promise<VetoDecision | undefined> {
  const toolCallId = `acp-perm-${randomUUID()}`;
  const reqPromise = args.conn.requestPermission({
    sessionId: args.sessionId,
    toolCall: {
      toolCallId,
      title: toolName,
      kind: toolKind(toolName),
      status: "pending",
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("permission_timeout"));
    }, args.timeoutMs);
  });

  let response: acp.RequestPermissionResponse;
  try {
    response = (await Promise.race([reqPromise, timeoutPromise])) as acp.RequestPermissionResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "permission_timeout") {
      return { block: true, message: `permission timed out after ${args.timeoutMs}ms` };
    }
    return { block: true, message: `permission request failed (client disconnected?): ${msg}` };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  const outcome = response.outcome;
  if (outcome.outcome === "cancelled") {
    return { block: true, message: "permission cancelled by client" };
  }
  if (outcome.outcome === "selected" && outcome.optionId === "deny") {
    return { block: true, message: "denied by user" };
  }
  return undefined;
}

type PluginManagerLike = {
  register?: (p: unknown) => Promise<void> | void;
  initialize?: (plugins: unknown[]) => Promise<void>;
};

/**
 * Return the agent's plugin manager (read structurally; `LocalAgent` exposes `pluginManager()`).
 *
 * **Fail-closed (SEC-M0-03):** THROWS `ConfigurationError` (`permission_enforcement_unavailable`)
 * when there is none, so tools never run ungated while the operator believes they are gated.
 */
export function assertPermissionEnforceable(
  agent: AgentLike,
  mode: PermissionMode,
  sessionId: string,
): PluginManagerLike {
  const mgr = (agent as AgentLike & { pluginManager?: () => PluginManagerLike | undefined })
    .pluginManager?.();
  if (mgr === undefined) {
    throw new ConfigurationError(
      `permission enforcement unavailable on this runtime (no plugin manager) — ` +
        `cannot honor permissionDefault="${mode}" for session "${sessionId}"`,
      { code: "permission_enforcement_unavailable" },
    );
  }
  return mgr;
}

/**
 * Install the tool-permission veto on an SDK agent, for one session.
 *
 * Call it once per prompt (the prompt handler does); the plugin name is derived from the session id,
 * and re-registering under the same name relies on the SDK's `pre_tool_call` subscription contract
 * rather than on bookkeeping here.
 *
 * **Fail-closed (SEC-M0-03):** when `mode` is `deny`/`ask` but the runtime has
 * no plugin manager (e.g. a CloudAgent), enforcement is impossible — this
 * THROWS a `ConfigurationError` rather than letting tools run ungated. Awaiting
 * `register` (ARCH-08/SEC-M0-05) guarantees the veto hook is aggregated before
 * the first tool dispatch.
 */
export async function installPermissionPlugin(
  agent: AgentLike,
  args: PermissionPluginArgs,
): Promise<void> {
  const plugin = Plugin.create({
    name: `acp-permission-${args.sessionId}`,
    version: "1.0.0",
    kind: "general",
    register(ctx) {
      ctx.on("pre_tool_call", async (rawCtx) => {
        const event = rawCtx as { name: string; args: Record<string, unknown> };
        if (args.mode === "deny") {
          return { block: true, message: "denied (permissionDefault=deny)" };
        }
        if (args.trustedTools.has(event.name)) {
          return undefined;
        }
        // mode === "ask"
        return askWithTimeout(args, event.name);
      });
    },
  });

  const mgr = assertPermissionEnforceable(agent, args.mode, args.sessionId);
  // ARCH-08/SEC-M0-05 — await so the veto hook is aggregated before any tool
  // dispatch, and an async registration failure surfaces (not an unhandled
  // rejection).
  if (typeof mgr.register === "function") {
    await mgr.register(plugin);
  } else if (typeof mgr.initialize === "function") {
    await mgr.initialize([plugin]);
  }
}
