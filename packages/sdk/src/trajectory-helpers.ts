/**
 * `toShareGptTrajectory` — opt-in BatchResult → ShareGPT converter (ADR D139).
 *
 * Pure transformation. Returns `null` for failed results so callers can
 * filter via `.map(toShareGptTrajectory).filter(Boolean)`. Tool calls and
 * tool results are preserved when an SDKMessage trace is provided; otherwise
 * a minimal `human → gpt` trajectory is emitted from the final text.
 *
 * @public
 */

import type { BatchResult } from "./types/batch.js";
import type { SDKMessage, TextBlock, ToolUseBlock } from "./types/messages.js";
import type { ShareGptMessage, ShareGptTrajectory } from "./types/trajectory.js";

/**
 * Convert a successful `BatchResult` to ShareGPT-format trajectory.
 *
 * Behavior:
 * - `result.ok === false` → returns `null` (EC-11).
 * - First entry is always `{from: "human", value: result.prompt}`.
 * - When `options.messages` is supplied, each SDKMessage maps to one or
 *   more ShareGPT entries (assistant text → gpt, tool_use → gpt + tool).
 * - Without `options.messages`, fall back to a single `{from: "gpt"}`
 *   entry carrying `result.result.result` (the final text) when present.
 * - Malformed message entries are silently skipped (EC-F / EC-14).
 *
 * @public
 */
export function toShareGptTrajectory(
  result: BatchResult,
  options?: { messages?: SDKMessage[]; model?: string },
): ShareGptTrajectory | null {
  if (!result.ok) return null;
  const conversations = buildConversations(result, options?.messages);
  const trajectory: ShareGptTrajectory = {
    conversations,
    metadata: {
      timestamp: new Date().toISOString(),
      durationMs: result.durationMs,
      promptIndex: result.index,
      ...(options?.model !== undefined ? { model: options.model } : {}),
    },
    completed: true,
  };
  const usage = extractUsage(result.result);
  if (usage !== undefined) trajectory.usage = usage;
  return trajectory;
}

function buildConversations(
  result: Extract<BatchResult, { ok: true }>,
  messages: SDKMessage[] | undefined,
): ShareGptMessage[] {
  const conversations: ShareGptMessage[] = [{ from: "human", value: result.prompt }];
  if (Array.isArray(messages) && messages.length > 0) {
    for (const m of messages) {
      for (const entry of mapSdkMessage(m)) conversations.push(entry);
    }
    return conversations;
  }
  // Fall-back: minimal {gpt} entry with final text (EC-12).
  const finalText = typeof result.result.result === "string" ? result.result.result : "";
  conversations.push({ from: "gpt", value: finalText });
  return conversations;
}

function extractUsage(
  runResult: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = (runResult as { usage?: { inputTokens?: unknown; outputTokens?: unknown } })?.usage;
  if (usage === undefined) return undefined;
  if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") {
    return undefined;
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

/**
 * Map one SDKMessage to zero or more ShareGPT entries. Tool-use blocks
 * inside an assistant message split into a `gpt` entry with `tool_calls`
 * plus, when paired with a `tool_call.completed` event, a `tool` entry
 * carrying the result.
 *
 * Malformed shapes (missing `message.content`, non-array content) yield
 * an empty list — caller skips silently (EC-F).
 *
 * @internal
 */
function mapSdkMessage(m: SDKMessage): ShareGptMessage[] {
  if (m === null || typeof m !== "object") return [];
  switch (m.type) {
    case "assistant":
      return mapAssistant(m);
    case "tool_call":
      return mapToolCall(m);
    case "thinking":
    case "system":
    case "user":
    case "status":
    case "task":
    case "request":
    case "object_delta":
      return [];
    default: {
      // Exhaustive sentinel — unreachable on stable SDKMessage union.
      const _exhaustive: never = m;
      void _exhaustive;
      return [];
    }
  }
}

function mapAssistant(m: Extract<SDKMessage, { type: "assistant" }>): ShareGptMessage[] {
  const content = m.message?.content;
  if (!Array.isArray(content)) return [];
  const textParts: string[] = [];
  const toolCalls: NonNullable<ShareGptMessage["tool_calls"]> = [];
  for (const block of content) {
    appendBlock(block, textParts, toolCalls);
  }
  const entry: ShareGptMessage = { from: "gpt", value: textParts.join("") };
  if (toolCalls.length > 0) entry.tool_calls = toolCalls;
  return [entry];
}

function appendBlock(
  block: unknown,
  textParts: string[],
  toolCalls: NonNullable<ShareGptMessage["tool_calls"]>,
): void {
  if (block === null || typeof block !== "object") return;
  const text = block as TextBlock;
  if (text.type === "text" && typeof text.text === "string") {
    textParts.push(text.text);
    return;
  }
  const tu = block as ToolUseBlock;
  if (tu.type !== "tool_use") return;
  const args =
    tu.input !== null && typeof tu.input === "object" ? (tu.input as Record<string, unknown>) : {};
  toolCalls.push({ name: tu.name, arguments: args });
}

function mapToolCall(m: Extract<SDKMessage, { type: "tool_call" }>): ShareGptMessage[] {
  // Only emit once the call finished (completed or error); "running" is interim.
  if (m.status === "running") return [];
  const value =
    typeof m.result === "string" ? m.result : m.result === undefined ? "" : safeStringify(m.result);
  return [{ from: "tool", value }];
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
