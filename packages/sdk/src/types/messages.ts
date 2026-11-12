/**
 * Owner: `internal/agent-loop/` (4 of 16 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 */
// T4.1 / D438 — import from leaf to break the 3-node agent->run->messages cycle (#7).
import type { ModelSelection } from "./agent-prims.js";
// TextBlock / ImageBlock / ToolResultContentBlock live in the import-free leaf
// `content-blocks.ts` (SE7) so `agent-prims.ts` can reference them for the
// `CustomTool` handler result WITHOUT re-introducing the agent-prims↔messages
// cycle. Imported here for local use + re-exported so existing
// `from "./messages.js"` imports still work.
import type { TextBlock } from "./content-blocks.js";

export type { ImageBlock, TextBlock, ToolResultContentBlock } from "./content-blocks.js";

/**
 * Tool invocation block emitted by the assistant.
 *
 * @public
 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  /** Tool args are not part of the stable schema. Treat as unknown and parse defensively. */
  input: unknown;
}

/**
 * Init metadata. Emitted once at the start of a run.
 *
 * @public
 */
export interface SDKSystemMessage {
  type: "system";
  subtype?: "init";
  agent_id: string;
  run_id: string;
  model?: ModelSelection;
  tools?: string[];
}

/**
 * Echo of the user prompt for this run.
 *
 * @public
 */
export interface SDKUserMessageEvent {
  type: "user";
  agent_id: string;
  run_id: string;
  message: { role: "user"; content: TextBlock[] };
}

/**
 * Model text output for this run.
 *
 * @public
 */
export interface SDKAssistantMessage {
  type: "assistant";
  agent_id: string;
  run_id: string;
  message: {
    role: "assistant";
    content: Array<TextBlock | ToolUseBlock>;
  };
}

/**
 * Reasoning content.
 *
 * @public
 */
export interface SDKThinkingMessage {
  type: "thinking";
  agent_id: string;
  run_id: string;
  text: string;
  thinking_duration_ms?: number;
  /**
   * theokit#122 — the provider's cryptographic signature for this thinking block, when it issued
   * one. Anthropic requires a resumed conversation to replay each thinking block WITH its
   * signature; without it the next request fails with `400 "thinking blocks cannot be modified"`,
   * which made an extended-thinking session unresumable.
   *
   * Absent for providers that stream reasoning text unsigned (the OpenAI-compatible wire).
   */
  signature?: string;
}

/**
 * Tool invocation lifecycle event. Emitted at start with `args`, then again on
 * completion with `result`.
 *
 * The completion event has `status: "completed"` when `result.exitCode` is 0, and
 * `status: "error"` when it is non-zero: 1 for a handler that threw, 124 for a timeout or abort,
 * 126 for a call vetoed by a hook or plugin, 127 for an unknown tool. `result` is the same either way.
 *
 * Tool `args` and `result` are NOT part of the stable schema — treat as unknown.
 *
 * @public
 */
export interface SDKToolUseMessage {
  type: "tool_call";
  agent_id: string;
  run_id: string;
  call_id: string;
  name: string;
  status: "running" | "completed" | "error";
  args?: unknown;
  result?: unknown;
  truncated?: { args?: boolean; result?: boolean };
}

/**
 * Cloud run lifecycle transitions.
 *
 * @public
 */
export interface SDKStatusMessage {
  type: "status";
  agent_id: string;
  run_id: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
  message?: string;
}

/**
 * Task-level milestones and summaries.
 *
 * @public
 */
export interface SDKTaskMessage {
  type: "task";
  agent_id: string;
  run_id: string;
  status?: string;
  text?: string;
}

/**
 * Awaiting user input or approval.
 *
 * @public
 */
export interface SDKRequestMessage {
  type: "request";
  agent_id: string;
  run_id: string;
  request_id: string;
}

/**
 * Partial object emitted during `Agent.streamObject<T>` streaming (ADR D45).
 * `partial` is `DeepPartial<z.infer<T>>` at the typed iterator level but
 * erased to `unknown` here because SDKMessage union is non-generic.
 *
 * @public
 */
export interface SDKObjectDelta {
  type: "object_delta";
  agent_id: string;
  run_id: string;
  partial: unknown;
  attempt: number;
}

/**
 * Discriminated union of all stream events. Discriminate on `type`.
 *
 * All events include `agent_id` and `run_id`.
 *
 * @public
 */
export type SDKMessage =
  | SDKSystemMessage
  | SDKUserMessageEvent
  | SDKAssistantMessage
  | SDKThinkingMessage
  | SDKToolUseMessage
  | SDKStatusMessage
  | SDKTaskMessage
  | SDKRequestMessage
  | SDKObjectDelta;
