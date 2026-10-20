/**
 * Provider-agnostic LLM types used by the real agent loop. Each concrete
 * provider client (`anthropic.ts`, `openai.ts`) accepts an `LlmRequest`
 * and yields a stream of `LlmEvent`s plus a final `LlmFinish` shape that
 * the agent loop converts into our `SDKMessage` events.
 *
 * Semver-exempt: nothing here is declared in `package.json` `exports`. These types are nonetheless
 * reachable from published declarations through the type graph, so they must be EMITTED.
 *
 * NOTE — no internal-visibility tag in this block. `tsconfig.base.json` sets `stripInternal: true`,
 * and TypeScript scans EVERY leading comment range of the declaration that follows. The tag that
 * used to sit here deleted `LlmTool` from the emitted `.d.ts` while `LlmRequest`, which names it,
 * survived — a declaration that does not compile for any consumer running type-aware lint.
 */

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmTextPart {
  type: "text";
  text: string;
}

export interface LlmToolCallPart {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmToolResultPart {
  type: "tool_result";
  toolUseId: string;
  /**
   * SE7 — a string (the common case) OR structured content blocks (text +
   * image). Block-capable provider wires forward blocks natively; string-only
   * wires flatten text and fail fast on an image (`toStringToolResultContent`).
   */
  content: string | import("../../types/content-blocks.js").ToolResultContentBlock[];
  isError?: boolean;
}

/**
 * M35 (multimodal) — an image part in a user message. `source` mirrors the `ImageBlock` shape
 * (`{ type: "base64", media_type, data }`) so provider adapters serialize it to their own image format
 * (OpenAI/OpenRouter `image_url` with a data URL; Anthropic native base64 source).
 */
export interface LlmImagePart {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}

/**
 * theokit#122 — an extended-thinking block, carried WITH its provider-issued signature.
 *
 * The signature is the whole reason this part exists. Anthropic requires a resumed conversation to
 * replay each `thinking` block byte-identically, signature included; replaying the text alone is
 * rejected with `400 "thinking blocks cannot be modified"` (anthropics/claude-code#63147). So a
 * session that used extended thinking could be persisted but never resumed.
 *
 * `signature` is optional because not every provider issues one — the OpenAI-compatible reasoning
 * channel streams `reasoning`/`reasoning_content` text with no signature at all. A part without a
 * signature is display-only history; it must not be replayed to Anthropic as a thinking block.
 */
export interface LlmThinkingPart {
  type: "thinking";
  text: string;
  signature?: string;
}

export type LlmContentPart =
  | LlmTextPart
  | LlmToolCallPart
  | LlmToolResultPart
  | LlmImagePart
  | LlmThinkingPart;

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: LlmContentPart[];
}

/**
 * T3.5 — a single system-prompt block. Used by `LlmRequest.system` when the
 * caller wants to opt into Anthropic prompt caching: each block whose
 * `cacheable` is `true` gets the `cache_control: {type: 'ephemeral'}`
 * annotation in the Anthropic wire body, which lets Anthropic bill
 * subsequent same-content requests at the cache-read rate (1-3x discount).
 *
 * OpenRouter receives the blocks as `content` parts of the `system` message,
 * with `cache_control` on each cacheable part. Every other chat-completions
 * provider (OpenAI and the compatible ones) gets the array joined into a
 * single string at the wire boundary. Back-compat: `LlmRequest.system` still
 * accepts a plain `string` (pre-T3.5 callers compile unchanged).
 */
export interface LlmSystemBlock {
  text: string;
  /** When `true`, ask the provider to cache this block (Anthropic, and OpenRouter content parts). */
  cacheable?: boolean;
}

/**
 * T3.6 — `LlmRequest.responseFormat` opt-in for OpenAI native structured
 * outputs. When set, providers that support it emit the response strictly
 * matching the schema (no parse retries; lower latency than the
 * synthetic-tool fallback path).
 *
 * Two shapes:
 *  - `{ type: "json_schema", jsonSchema: { name, schema, strict? } }` —
 *    the canonical structured-outputs shape (`gpt-4o-2024-08-06+`).
 *    `strict` defaults to `true` (provider guarantees match).
 *  - `{ type: "json_object" }` — the legacy "JSON mode" hint (older
 *    OpenAI models). Returns JSON but does NOT guarantee schema match.
 *
 * Providers that don't support the field (Anthropic, Ollama) silently
 * ignore it at the wire layer (`buildAnthropicCommonBody`,
 * `buildOllamaChatBody`).
 */
export type LlmResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      jsonSchema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

export interface LlmRequest {
  model: string;
  system?: string | LlmSystemBlock[];
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  temperature?: number;
  /** T3.6 — opt into native structured outputs (OpenAI-compat providers). */
  responseFormat?: LlmResponseFormat;
  /**
   * Reasoning / extended-thinking request (issue #47). Derived from `ModelSelection.params` (the
   * `thinking` param). The wire encoding is provider-specific: OpenRouter (and OpenAI-compatible
   * passthroughs) use the unified `reasoning: { effort }` object; native OpenAI Chat Completions uses
   * the top-level `reasoning_effort` string (see `buildOpenAIBody`). The model streams reasoning back
   * as `delta.reasoning` (or `delta.reasoning_content` on some compat providers), surfaced as
   * `reasoning_delta` events. `effort` is required once the object is present — an empty object would
   * request nothing.
   */
  reasoning?: { effort: string };
  /**
   * Step-cap force-close: per-request tool gating. `"none"` tells the provider to emit no tool
   * calls even when `tools` are present (forcing a text answer); `"required"` forces a tool call;
   * `"auto"` (or omitted) is the default. Maps to OpenAI/OpenRouter `tool_choice`. The agent loop
   * sets `"none"` on a final/ceiling round so a cached agent (whose tools cannot be un-registered)
   * is still forced to produce a closing summary.
   */
  toolChoice?: "auto" | "none" | "required";
  /**
   * usetheokit/theokit-sdk#383 — an opaque key identifying the conversation whose prompt prefix the
   * provider may reuse across requests. Maps to the Responses-API `prompt_cache_key`.
   *
   * Set by the agent loop from the run's session identity and derived through
   * `derivePromptCacheKey`, so it is STABLE across every round of a turn and every turn of a
   * session, and DISTINCT between unrelated sessions. Both halves matter: a key that changes per
   * round caches nothing, and a key shared across sessions asks the provider to match one
   * conversation's prefix against another's.
   *
   * Absent ⇒ the field is omitted from the wire body (the pre-#383 request, byte for byte). It is
   * a request-shaping hint only: no provider behaviour depends on its presence except the billing
   * of the cached prefix.
   */
  promptCacheKey?: string;
}

/**
 * What a provider stream reports WHILE it is running. Tool calls are deliberately absent.
 *
 * theokit#144: this union used to declare `tool_use` and `stop` variants. Only two providers ever
 * yielded them (`responses.ts`, `fault-injection.ts`), the loop's collector
 * (`loop-llm-stream.ts`) never read them, and the tool calls they carried were duplicates of what
 * `LlmFinish.toolCalls` already returned. So they were not a live tool channel — they were a
 * declaration of one, which is worse: it told implementers a provider-level channel existed and
 * cost `@theokit/agents` a workaround (holding every `text_delta` until the stream drained, which
 * broke live token streaming on text-only turns — issue #47).
 *
 * Wiring them instead of deleting them was rejected: `openai.ts` and `anthropic.ts` cannot produce
 * them at all (their tool calls only resolve at completion), so a live provider-level channel would
 * exist on some providers and not others — a worse contract than a uniform one.
 *
 * **The canonical live tool channel is `onDelta`**: `tool-call-started` / `tool-call-completed`
 * `InteractionUpdate`s, emitted by `runToolWithLifecycle` (`agent-loop/tool-dispatch.ts`) between
 * LLM rounds. It is uniform across providers, carries a `callId` correlating the two ends, and
 * fires before the post-tool answer text. `Run.events()` (theokit#140) merges it with the
 * structural `SDKMessage`s into one ordered timeline.
 *
 * The stop reason is not an event either — it is returned once, on `LlmFinish.stopReason`.
 */
export type LlmEvent =
  | { type: "text_delta"; text: string }
  // theokit#122 — `signature` rides the reasoning channel because Anthropic delivers it as a
  // `signature_delta` on the SAME content block as the thinking text. Present only on the delta
  // that carries it, so the accumulator keeps the last one seen for the block.
  | { type: "reasoning_delta"; text: string; signature?: string }
  | { type: "error"; message: string };

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";

export interface LlmFinish {
  stopReason: LlmStopReason;
  text: string;
  toolCalls: LlmToolCallPart[];
  /**
   * Uncached input tokens, the way Anthropic reports them. The chat-completions client subtracts
   * the cache buckets from the provider's cache-inclusive `prompt_tokens` to match.
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Cache read tokens (Anthropic prompt caching / OpenAI cached). ADR D376. */
  cacheReadTokens?: number;
  /** Cache creation tokens (Anthropic, and OpenRouter's `cache_write_tokens`). ADR D376. */
  cacheWriteTokens?: number;
  /** Reasoning tokens (OpenAI o-series). ADR D376. */
  reasoningTokens?: number;
  /**
   * theokit#122 — the turn's extended-thinking block, with the provider's signature when it issued
   * one. Returned on the finish value rather than reconstructed from the `reasoning_delta` text,
   * because the signature arrives once for the whole block and only the provider adapter knows
   * which block it belongs to.
   */
  thinking?: LlmThinkingPart;
}

export interface LlmClient {
  readonly name: string;
  stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent, LlmFinish, void>;
}
