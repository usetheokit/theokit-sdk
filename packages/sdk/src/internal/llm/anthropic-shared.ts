/**
 * Shared helpers for Anthropic Messages wire format across direct API
 * (anthropic.ts), Vertex (vertex-anthropic.ts), and Bedrock (bedrock-anthropic.ts)
 * clients. Extracted to remove cross-module clones flagged by jscpd.
 *
 * @internal
 */

import { parseToolArguments } from "./finish.js";
import { toBlockToolResultContent } from "./tool-result-content.js";
import type {
  LlmContentPart,
  LlmMessage,
  LlmRequest,
  LlmStopReason,
  LlmSystemBlock,
  LlmToolCallPart,
} from "./types.js";

export interface AnthropicResponseLike {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function extractAnthropicText(response: AnthropicResponseLike): string {
  return (response.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export function extractAnthropicToolCalls(response: AnthropicResponseLike): LlmToolCallPart[] {
  return (response.content ?? [])
    .filter(
      (c): c is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        c.type === "tool_use",
    )
    .map((c) => ({
      type: "tool_use" as const,
      id: c.id,
      name: c.name,
      input: parseToolArguments(JSON.stringify(c.input)),
    }));
}

export function mapAnthropicStopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "end_turn":
    case null:
      return "end_turn";
    default:
      return "end_turn";
  }
}

/**
 * theokit#122 — replay an extended-thinking block WITH its signature.
 *
 * Anthropic verifies the signature against the text, so both must go back byte-identically or the
 * request is rejected with `400 "thinking blocks cannot be modified"`. A part with no signature —
 * an OpenAI-compatible provider's reasoning text, or history recorded before this shipped — is
 * dropped rather than sent unsigned: an unsigned block fails the same validation, so sending it
 * would break the whole turn instead of losing one block of context.
 */
function thinkingToWireBlock(
  part: Extract<LlmContentPart, { type: "thinking" }>,
): Record<string, unknown> | undefined {
  return part.signature === undefined
    ? undefined
    : { type: "thinking", thinking: part.text, signature: part.signature };
}

/** Map one SDK content part to its Anthropic wire block (`undefined` = do not send). */
function partToWireBlock(part: LlmContentPart): Record<string, unknown> | undefined {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "tool_use") {
    return { type: "tool_use", id: part.id, name: part.name, input: part.input };
  }
  // M35 — Anthropic native image block: base64 source, unchanged shape.
  if (part.type === "image") return { type: "image", source: part.source };
  if (part.type === "thinking") return thinkingToWireBlock(part);
  return {
    type: "tool_result",
    tool_use_id: part.toolUseId,
    // SE7 — this wire is block-capable: strings pass through, structured
    // text/image blocks are forwarded natively.
    content: toBlockToolResultContent(part.content),
    ...(part.isError === true ? { is_error: true } : {}),
  };
}

/**
 * Convert an SDK `LlmMessage` to the Anthropic Messages wire shape.
 * Identical across the three Anthropic-compatible clients (D289/D292).
 */
export function toAnthropicWireMessage(message: LlmMessage): Record<string, unknown> {
  const role = message.role === "system" ? "user" : message.role;
  // theokit#122 — `filter` drops the blocks the mapper declined to serialize.
  const content = message.content
    .map(partToWireBlock)
    .filter((b): b is Record<string, unknown> => b !== undefined);
  return { role, content };
}

/**
 * Issue a POST to an Anthropic-compatible Messages endpoint with the
 * standard auth + content-type headers. Caller maps non-2xx via its own
 * dialect-specific error mapper.
 */
export function postAnthropicRequest(args: {
  fetchImpl: typeof fetch;
  url: string;
  token: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<Response> {
  return args.fetchImpl(args.url, {
    method: "POST",
    signal: args.signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify(args.body),
  });
}

/**
 * Map non-2xx response to a typed error via the dialect mapper; consume
 * 2xx body into the Anthropic-shape result. Shared by Bedrock + Vertex
 * Anthropic clients to remove the ~15-line clone (jscpd).
 */
export async function handleAnthropicResponse(args: {
  response: Response;
  endpoint: string;
  errorMapper: (info: {
    status: number;
    body: unknown;
    headers: Headers;
    endpoint: string;
  }) => Error;
}): Promise<{
  text: string;
  toolCalls: LlmToolCallPart[];
  stopReason: LlmStopReason;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}> {
  if (!args.response.ok) {
    throw args.errorMapper({
      status: args.response.status,
      body: await parseHttpErrorBody(args.response),
      headers: args.response.headers,
      endpoint: args.endpoint,
    });
  }
  return consumeAnthropicResponse(args.response);
}

export async function consumeAnthropicResponse(response: Response): Promise<{
  text: string;
  toolCalls: LlmToolCallPart[];
  stopReason: LlmStopReason;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}> {
  const data = (await response.json()) as AnthropicResponseLike;
  return {
    text: extractAnthropicText(data),
    toolCalls: extractAnthropicToolCalls(data),
    stopReason: mapAnthropicStopReason(data.stop_reason ?? null),
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
    // B-412 — the counters the Bedrock and Vertex Anthropic clients used to drop.
    cacheReadTokens: data.usage?.cache_read_input_tokens,
    cacheWriteTokens: data.usage?.cache_creation_input_tokens,
  };
}

export async function parseHttpErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * theokit#122 — map the provider-agnostic reasoning `effort` onto Anthropic's token budget.
 *
 * Anthropic does not take an effort label; it takes `budget_tokens`, and the API requires
 * `budget_tokens >= 1024` and `max_tokens > budget_tokens`. The three tiers mirror the effort
 * vocabulary the OpenAI-compatible wire uses, so a caller writes `thinking: "low"` once and both
 * providers do something sensible. An unrecognised effort maps to the medium tier rather than
 * failing the request — the knob is a hint, not a contract.
 */
function thinkingBudgetTokens(effort: string): number {
  if (effort === "low" || effort === "minimal") return 1024;
  if (effort === "high" || effort === "max") return 16_384;
  return 4096;
}

/**
 * Build the common body shape for Anthropic Messages requests. Caller
 * is responsible for adding wire-specific fields (`anthropic_version`,
 * `model`, `stream`, etc.).
 */
export function buildAnthropicCommonBody(request: LlmRequest): {
  max_tokens: number;
  messages: Array<Record<string, unknown>>;
  system?: string | AnthropicTextBlock[];
  temperature?: number;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  thinking?: { type: "enabled"; budget_tokens: number };
} {
  const body: ReturnType<typeof buildAnthropicCommonBody> = {
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicWireMessage),
  };
  // theokit#122 — without this the adapter never requested extended thinking, so no signature was
  // ever issued and the rest of the chain would have been dead code (the theokit#144 lesson).
  if (request.reasoning?.effort !== undefined) {
    const budget = thinkingBudgetTokens(request.reasoning.effort);
    body.thinking = { type: "enabled", budget_tokens: budget };
    // The API rejects `max_tokens <= budget_tokens`. Raise the ceiling rather than silently
    // shrinking the budget the caller asked for.
    if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
  }
  const wireSystem = encodeAnthropicSystem(request.system);
  if (wireSystem !== undefined) body.system = wireSystem;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
  return body;
}

/**
 * T3.5 — translate `LlmRequest.system` to the Anthropic wire shape.
 *
 * - `undefined` → omit (`undefined`).
 * - `string` → forward verbatim (back-compat, no caching).
 * - `LlmSystemBlock[]` → array of `{type:"text", text, cache_control?}`.
 *   `cacheable: true` → emit `cache_control:{type:"ephemeral"}`.
 *   Empty array short-circuits to `undefined`.
 *
 * @internal
 */
function encodeAnthropicSystem(
  system: string | LlmSystemBlock[] | undefined,
): string | AnthropicTextBlock[] | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  if (system.length === 0) return undefined;
  return system.map((block) => {
    const wire: AnthropicTextBlock = { type: "text", text: block.text };
    if (block.cacheable === true) wire.cache_control = { type: "ephemeral" };
    return wire;
  });
}
