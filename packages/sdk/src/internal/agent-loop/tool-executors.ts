import { type SplitResolver, TOOL_SPLIT_RESOLVER } from "../../define-tool.js";
import { ToolError } from "../../tool-error.js";
import type { ToolContextMessage } from "../../types/agent-prims.js";
import type { ToolResultContentBlock } from "../../types/content-blocks.js";
import type { LlmToolCallPart } from "../llm/types.js";
import { runShell, type ShellExecuteOptions } from "../runtime/tools/shell-tool.js";
import type { AgentLoopInputs, ResolvedTool } from "./types.js";

/** @internal */
export interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  /**
   * SE7 — authoritative tool_result content when set: a string OR structured
   * blocks (text + image). Populated by a handler that returns blocks, or a
   * `ToolError` (string or blocks); `stdout`/`stderr` remain for hooks/telemetry.
   * `undefined` → the legacy string path (`renderToolResult` over stdout/stderr).
   */
  content?: string | ToolResultContentBlock[];
  /**
   * SE17 — the FULL raw handler output (serialized), surfaced to observability
   * (`onToolEnd.result`) when a `toModelOutput` split is active. Distinct from
   * `content`/`stdout` (which carry the compact MODEL-facing value). `undefined`
   * for tools without a `toModelOutput` split — observability then falls back to
   * `content`/`stdout` (same value the model saw).
   */
  appResult?: string | ToolResultContentBlock[];
}

/** @internal */
export async function executeTool(
  inputs: AgentLoopInputs,
  resolved: ResolvedTool | undefined,
  call: LlmToolCallPart,
): Promise<ToolResult> {
  if (resolved === undefined) {
    return { stdout: "", stderr: `Unknown tool ${call.name}`, exitCode: 127 };
  }
  if (resolved.origin === "shell") return runShellTool(inputs, call);
  // #119 — `inputs.agentId` is the run's session identity (the `Agent.getOrCreate(sessionId)`
  // key). Threaded to the handler as `ctx.threadId` so a stateful tool can scope state per session.
  // The two handler origins differ ONLY in what the handler is allowed to see, and the difference
  // is now the presence of a key rather than the position of an `undefined`. Memory tools get no
  // cancellation signal and no transcript projection — deliberate, and previously expressed as two
  // bare `undefined` three slots apart in a 7-argument call.
  if (resolved.origin === "memory")
    return runHandlerTool("memory", resolved.memoryHandler, call, {
      context: inputs.context,
      threadId: inputs.agentId,
    });
  if (resolved.origin === "custom")
    return runHandlerTool("custom", resolved.customHandler, call, {
      signal: inputs.signal,
      context: inputs.context,
      messages: inputs.messages,
      threadId: inputs.agentId,
    });
  return runMcpTool(inputs, resolved, call);
}

/**
 * What a tool handler receives alongside its input. It always WAS one object — the handler's own
 * second parameter — and `runHandlerTool` spent four positional slots re-assembling it. Nothing in
 * the type system separated `AbortSignal | undefined` from `ToolContextMessage[] | undefined` when
 * both arrived as a literal `undefined`, so transposing them compiled and silently turned off either
 * tool cancellation or the transcript projection.
 */
interface HandlerToolCtx {
  readonly signal?: AbortSignal | undefined;
  readonly context?: unknown;
  readonly messages?: readonly ToolContextMessage[] | undefined;
  readonly threadId?: string | undefined;
}

async function runHandlerTool(
  kind: "memory" | "custom",
  handler:
    | ((
        input: Record<string, unknown>,
        ctx?: HandlerToolCtx,
      ) => string | ToolResultContentBlock[] | Promise<string | ToolResultContentBlock[]>)
    | undefined,
  call: LlmToolCallPart,
  ctx: HandlerToolCtx,
): Promise<ToolResult> {
  const { signal, context, messages, threadId } = ctx;
  if (handler === undefined) {
    return { stdout: "", stderr: `${kind} tool ${call.name} has no handler`, exitCode: 127 };
  }
  try {
    // #65 — the run's abort signal on the ToolContext. M7 — also the run's user
    // `context` (from SendOptions.context). SE12 — `messages` is the read-only
    // transcript projection (custom tools only; memory tools pass undefined).
    // Single-arg handlers ignore all of them.
    // SE17 — a `toModelOutput` tool carries a split resolver on its handler: run it
    // ONCE and route the compact `model` channel to the tool_result while the full
    // `app` channel reaches `onToolEnd`. Absent ⇒ the plain single-channel path.
    const split = (handler as unknown as Record<symbol, SplitResolver | undefined>)[
      TOOL_SPLIT_RESOLVER
    ];
    if (split !== undefined) {
      const { model, app } = await split(call.input, { signal, context, threadId });
      const base: ToolResult =
        typeof model === "string"
          ? { stdout: model, stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0, content: model };
      return { ...base, appResult: app };
    }
    const out = await handler(call.input, { signal, context, messages, threadId });
    // SE7 — a handler may return structured content blocks (text + image).
    if (typeof out !== "string") return { stdout: "", stderr: "", exitCode: 0, content: out };
    return { stdout: out, stderr: "", exitCode: 0 };
  } catch (cause) {
    // SE7 — a `ToolError` carries the error content (string or blocks) as the
    // authoritative tool_result content; `stderr` keeps the text message for the
    // `onToolError` hook. A string ToolError stays a string on the wire (symmetric
    // with a string handler return), a block ToolError carries its blocks.
    if (cause instanceof ToolError) {
      return { stdout: "", stderr: cause.message, exitCode: 1, content: cause.content };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return { stdout: "", stderr: message, exitCode: 1 };
  }
}

async function runShellTool(inputs: AgentLoopInputs, call: LlmToolCallPart): Promise<ToolResult> {
  const command =
    typeof call.input.command === "string" ? call.input.command : JSON.stringify(call.input);
  const shellOptions: ShellExecuteOptions = {
    command,
    cwd: inputs.shellCwd,
    sandbox: inputs.shellSandbox,
  };
  const result = await runShell(shellOptions);
  const final: ToolResult = { stdout: result.stdout, stderr: result.stderr };
  if (result.exitCode !== null && result.exitCode !== undefined) final.exitCode = result.exitCode;
  return final;
}

async function runMcpTool(
  inputs: AgentLoopInputs,
  resolved: ResolvedTool,
  call: LlmToolCallPart,
): Promise<ToolResult> {
  const client = inputs.mcp.get(resolved.mcpServerName ?? "");
  if (client === undefined || resolved.mcpToolName === undefined) {
    return {
      stdout: "",
      stderr: `MCP server ${resolved.mcpServerName ?? "?"} not connected`,
      exitCode: 127,
    };
  }
  try {
    const response = await client.callTool(resolved.mcpToolName, call.input);
    const text = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return { stdout: text, stderr: "", exitCode: response.isError === true ? 1 : 0 };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { stdout: "", stderr: message, exitCode: 1 };
  }
}

/** @internal */
export function renderToolResult(result: ToolResult): string {
  if (result.stderr.length > 0 && (result.exitCode ?? 0) !== 0) {
    return `${result.stdout}\n[stderr]\n${result.stderr}`.trim();
  }
  return result.stdout.trim();
}
