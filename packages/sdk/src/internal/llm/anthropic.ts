import { NetworkError } from "../../errors.js";
import { mapAnthropicError } from "../error-mappers/anthropic.js";
import { boundFetch } from "../runtime-fetch.js";
import { buildAnthropicCommonBody, mapAnthropicStopReason } from "./anthropic-shared.js";
import { makeLlmFinish, parseToolArguments } from "./finish.js";
import { parseSseStream } from "./sse.js";
import { wrapTransportError } from "./transport-error.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmRequest,
  LlmStopReason,
  LlmToolCallPart,
} from "./types.js";

/**
 * Real Anthropic Messages client. Streams `/v1/messages` and translates the
 * vendor SSE events (`content_block_delta`, `content_block_start`,
 * `message_delta`, `message_stop`) into our provider-agnostic `LlmEvent`s.
 *
 * Uses native `fetch` only — no `@anthropic-ai/sdk` dependency.
 *
 * @internal
 */

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  version?: string;
  fetch?: typeof fetch;
  /**
   * M45 — extra HTTP headers merged into the request (the profile's static `extraHeaders` + a provider
   * `transform.headers(ctx)`). Assigned AFTER the base headers (mirror of the M41 OpenAIClient wiring), so
   * a provider that owns its auth CAN override them by design.
   */
  extraHeaders?: Record<string, string>;
}

interface AnthropicTextDelta {
  type: "content_block_delta";
  delta: { type: "text_delta"; text: string };
}

interface AnthropicToolStart {
  type: "content_block_start";
  index: number;
  content_block: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
}

/**
 * theokit#122 — the extended-thinking wire.
 *
 * Anthropic opens a `thinking` content block, streams its text as `thinking_delta`, and then emits
 * ONE `signature_delta` carrying the cryptographic signature for that block. All three are needed:
 * replaying the text without the signature is rejected on the next turn with
 * `400 "thinking blocks cannot be modified"`.
 */
interface AnthropicThinkingStart {
  type: "content_block_start";
  index: number;
  content_block: { type: "thinking"; thinking?: string; signature?: string };
}

interface AnthropicThinkingDelta {
  type: "content_block_delta";
  index: number;
  delta: { type: "thinking_delta"; thinking: string };
}

interface AnthropicSignatureDelta {
  type: "content_block_delta";
  index: number;
  delta: { type: "signature_delta"; signature: string };
}

interface AnthropicToolDelta {
  type: "content_block_delta";
  index: number;
  delta: { type: "input_json_delta"; partial_json: string };
}

interface AnthropicMessageDelta {
  type: "message_delta";
  delta: { stop_reason: string | null };
  /**
   * T3.8 — Anthropic native usage shape carries the 5-bucket cache counters
   * when the request annotated system blocks with `cache_control:
   * {type:"ephemeral"}` (shipped in T3.5). `cache_creation_input_tokens`
   * surfaces as `LlmFinish.cacheWriteTokens` (the 1.25x billing tier);
   * `cache_read_input_tokens` surfaces as `LlmFinish.cacheReadTokens` (the
   * 0.1x billing tier). Pre-T3.8 the SDK dropped both fields silently.
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

type AnthropicEvent =
  | AnthropicTextDelta
  | AnthropicToolStart
  | AnthropicToolDelta
  | AnthropicThinkingStart
  | AnthropicThinkingDelta
  | AnthropicSignatureDelta
  | AnthropicMessageDelta
  | { type: "message_stop" }
  | { type: string };

export class AnthropicClient implements LlmClient {
  readonly name = "anthropic";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.fetchImpl = boundFetch(options.fetch);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: HTTP+SSE handshake + accumulator is intentionally one block
  async *stream(
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmEvent, LlmFinish, void> {
    const body = buildAnthropicBody(request);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.options.apiKey,
      "anthropic-version": this.options.version ?? "2023-06-01",
    };
    // M45 — merge extra/dynamic headers (assign LAST — same override semantics as the chat_completions client).
    if (this.options.extraHeaders !== undefined) Object.assign(headers, this.options.extraHeaders);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      // M93 — a socket failure has no `Response`, so `mapAnthropicError` never saw it and it
      // propagated raw. A foreign error is NON-transient per `isTransientError`'s contract, so
      // retry was switched off on exactly the ECONNREFUSED/ETIMEDOUT case.
      throw wrapTransportError(fetchErr, { providerId: this.name, endpoint: "/v1/messages" });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Parse body as JSON when possible — gives the mapper access to
      // `error.code` / `error.type` fields. Leave as string otherwise.
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON — keep as string
      }
      throw mapAnthropicError({
        status: response.status,
        body,
        headers: response.headers,
        endpoint: "/v1/messages",
      });
    }

    const accumulator = new AnthropicStreamAccumulator();
    for await (const record of parseSseStream(response.body, signal)) {
      if (record.event === "ping" || record.event === "message_start") continue;
      let parsed: AnthropicEvent;
      try {
        parsed = JSON.parse(record.data) as AnthropicEvent;
      } catch {
        continue;
      }
      const events = accumulator.consume(parsed);
      for (const event of events) yield event;
    }
    // M2 #61 — a stream that ended without a terminal `message_delta`
    // (stop_reason) was truncated (dropped connection / proxy hiccup); throw a
    // typed error rather than commit the partial turn as a clean `end_turn`
    // (parity with the OpenAI client's truncation guard).
    if (!accumulator.finishReasonSeen) {
      throw new NetworkError("Anthropic SSE stream truncated (no stop_reason)", {
        code: "stream_truncated",
      });
    }
    return accumulator.finish();
  }
}

class AnthropicStreamAccumulator {
  private text = "";
  private stopReason: LlmStopReason = "end_turn";
  /**
   * M2 #61 — whether a `message_delta` carrying a real `stop_reason` was seen.
   * A stream that closes before it is a truncation (server FIN / proxy hiccup),
   * not a clean `end_turn` — the caller throws `stream_truncated` on `false`.
   */
  private sawStopReason = false;
  private inputTokens?: number;
  private outputTokens?: number;
  private cacheReadTokens?: number;
  private cacheWriteTokens?: number;
  private readonly toolCalls = new Map<number, LlmToolCallPart>();
  private readonly toolBuffers = new Map<number, string>();
  /**
   * theokit#122 — the turn's thinking block. Text accumulates across `thinking_delta`s; the
   * signature arrives once, on a `signature_delta` for the same block. Undefined until the model
   * actually opens a thinking block, so a non-thinking turn reports nothing.
   */
  private thinking: { text: string; signature?: string } | undefined;

  consume(event: AnthropicEvent): LlmEvent[] {
    if (event.type === "content_block_start") {
      const block = (event as AnthropicToolStart | AnthropicThinkingStart).content_block;
      if (block.type === "thinking") this.handleThinkingStart(event as AnthropicThinkingStart);
      else this.handleToolStart(event as AnthropicToolStart);
      return [];
    }
    if (event.type === "content_block_delta") {
      return this.handleContentDelta(event as AnthropicTextDelta | AnthropicToolDelta);
    }
    if (event.type === "message_delta") {
      this.handleMessageDelta(event as AnthropicMessageDelta);
    }
    return [];
  }

  private handleToolStart(start: AnthropicToolStart): void {
    if (start.content_block.type !== "tool_use") return;
    this.toolCalls.set(start.index, {
      type: "tool_use",
      id: start.content_block.id,
      name: start.content_block.name,
      input: { ...start.content_block.input },
    });
    this.toolBuffers.set(start.index, "");
  }

  private handleThinkingStart(start: AnthropicThinkingStart): void {
    // A thinking block can open carrying its opening text (and, on a replayed block, a signature).
    this.thinking = {
      text: start.content_block.thinking ?? "",
      ...(start.content_block.signature !== undefined
        ? { signature: start.content_block.signature }
        : {}),
    };
  }

  private handleContentDelta(
    delta:
      | AnthropicTextDelta
      | AnthropicToolDelta
      | AnthropicThinkingDelta
      | AnthropicSignatureDelta,
  ): LlmEvent[] {
    if (delta.delta.type === "text_delta") {
      const text = (delta as AnthropicTextDelta).delta.text;
      this.text += text;
      return [{ type: "text_delta", text }];
    }
    // theokit#122 — extended thinking streams on its own channel, surfaced as `reasoning_delta`
    // exactly like the OpenAI-compatible providers, so the loop needs no provider branch.
    if (delta.delta.type === "thinking_delta") {
      const text = (delta as AnthropicThinkingDelta).delta.thinking;
      this.thinking = {
        ...(this.thinking ?? { text: "" }),
        text: (this.thinking?.text ?? "") + text,
      };
      return [{ type: "reasoning_delta", text }];
    }
    // The signature closes the block. It carries no text, so it rides an empty reasoning delta —
    // the loop's accumulator keeps the last signature it sees for the turn.
    if (delta.delta.type === "signature_delta") {
      const signature = (delta as AnthropicSignatureDelta).delta.signature;
      this.thinking = { text: this.thinking?.text ?? "", signature };
      return [{ type: "reasoning_delta", text: "", signature }];
    }
    const idx = (delta as AnthropicToolDelta).index;
    const existing = this.toolBuffers.get(idx) ?? "";
    this.toolBuffers.set(idx, existing + (delta as AnthropicToolDelta).delta.partial_json);
    return [];
  }

  /**
   * T3.8 — extract token counters from Anthropic's `message_delta` usage.
   * Public on the class so the test seam can drive it directly without
   * spinning the SSE parser.
   */
  handleMessageDelta(md: AnthropicMessageDelta): void {
    if (md.delta.stop_reason !== undefined && md.delta.stop_reason !== null) {
      this.sawStopReason = true;
    }
    this.stopReason = mapAnthropicStopReason(md.delta.stop_reason);
    if (md.usage?.input_tokens !== undefined) this.inputTokens = md.usage.input_tokens;
    if (md.usage?.output_tokens !== undefined) this.outputTokens = md.usage.output_tokens;
    // T3.8 — treat 0 as "no cache activity" and leave the bucket
    // unreported (mirrors usage-accumulator's filter where zero-value
    // entries are stripped from the emitted TokenUsage).
    if (
      md.usage?.cache_creation_input_tokens !== undefined &&
      md.usage.cache_creation_input_tokens > 0
    ) {
      this.cacheWriteTokens = md.usage.cache_creation_input_tokens;
    }
    if (md.usage?.cache_read_input_tokens !== undefined && md.usage.cache_read_input_tokens > 0) {
      this.cacheReadTokens = md.usage.cache_read_input_tokens;
    }
  }

  /** M2 #61 — whether the terminal `message_delta` (stop_reason) was seen. */
  get finishReasonSeen(): boolean {
    return this.sawStopReason;
  }

  finish(): LlmFinish {
    const toolCalls: LlmToolCallPart[] = [];
    for (const [index, tool] of this.toolCalls.entries()) {
      const buffered = this.toolBuffers.get(index);
      const parsed = parseToolArguments(buffered);
      if (Object.keys(parsed).length > 0) tool.input = parsed;
      toolCalls.push(tool);
    }
    return makeLlmFinish({
      stopReason: this.stopReason,
      text: this.text,
      toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      // T3.8 — surface Anthropic native cache-token counters when the
      // request used `cache_control: {type:"ephemeral"}` on system blocks.
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      // theokit#122 — carry the thinking block + its signature so the turn can be replayed.
      ...(this.thinking !== undefined
        ? { thinking: { type: "thinking" as const, ...this.thinking } }
        : {}),
    });
  }
}

/**
 * T3.8 — test seam: exposes the AnthropicStreamAccumulator directly so
 * unit tests can drive the message_delta path without spinning the SSE
 * parser. `@internal` — not part of the public surface.
 */
export const __testing__AnthropicAccumulator = AnthropicStreamAccumulator;

function buildAnthropicBody(request: LlmRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    ...buildAnthropicCommonBody(request),
  };
}
