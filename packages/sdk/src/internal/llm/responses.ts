/**
 * OpenAI **Responses API** transport (`apiMode: "responses_api"`).
 *
 * The SDK's `ApiMode` declared `"responses_api"` but shipped NO transport — `selectTransport` threw
 * `transport_unavailable`. This IS that
 * transport: an `LlmClient` that POSTs the Responses-API body to `${baseUrl}/responses` and translates the
 * SSE event stream into `LlmEvent`/`LlmFinish`. It powers the ChatGPT Codex backend
 * (`https://chatgpt.com/backend-api/codex/responses`) and any responses-API provider.
 *
 * The request-body shape and the SSE event names/fields follow the OpenAI Responses API wire protocol
 * (event names, field access, terminal/usage handling), implemented against theokit's
 * `LlmClient` contract (`name` + `stream → AsyncGenerator<LlmEvent, LlmFinish>`).
 *
 * `extraHeaders` (unused by the chat-completions transport until now) + `baseUrl` are consumed here; a `fetch`
 * override lets a host inject a refresh-aware fetch (dynamic `ChatGPT-Account-Id` / `session-id`, mid-turn
 * token refresh) — mirroring `OpenAIClient`.
 */
import { mapOpenAICompatibleError } from "../error-mappers/openai-compatible.js";
import { collapseSystemText, makeLlmFinish, parseToolArguments } from "./finish.js";
import { parseSseStream } from "./sse.js";
import { toStringToolResultContent } from "./tool-result-content.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmMessage,
  LlmRequest,
  LlmStopReason,
  LlmToolCallPart,
} from "./types.js";

export interface ResponsesApiClientOptions {
  apiKey: string;
  /** e.g. `https://chatgpt.com/backend-api/codex`; the client POSTs `${baseUrl}/responses`. */
  baseUrl?: string;
  /** Static headers the profile declares (e.g. `ChatGPT-Account-Id`, `originator`). */
  extraHeaders?: Record<string, string>;
  /** Injected fetch (refresh-aware / dynamic headers). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  providerName?: string;
  /**
   * usetheokit/theokit-sdk#383 — carry the model's ENCRYPTED reasoning across the rounds of a turn.
   * Forwarded from `ProviderProfile.encryptedReasoning`; default off. See
   * {@link ResponsesBodyOptions.encryptedReasoning} for what it puts on the wire and why it is
   * opt-in rather than universal.
   */
  encryptedReasoning?: boolean;
}

/**
 * usetheokit/theokit-sdk#383 — one reasoning item the model produced, as it must be replayed.
 *
 * `encrypted_content` is opaque ciphertext only the provider can read; the SDK never inspects it,
 * never logs it, and never persists it. It exists to be handed straight back.
 */
interface ResponsesReasoningItem {
  id: string;
  encrypted_content: string;
}

/** Options that shape the request body beyond what an `LlmRequest` carries. */
export interface ResponsesBodyOptions {
  /**
   * usetheokit/theokit-sdk#383 — when `true`, add `include: ["reasoning.encrypted_content"]` and
   * `reasoning.context: "all_turns"`, and replay the reasoning items captured from earlier rounds.
   *
   * **What it buys.** With `store: false` the provider keeps nothing between requests, so a model
   * that reasoned its way to a tool call in round 1 starts round 2 with no memory of that reasoning
   * and derives it again — paid for again, every round. `include` asks the provider to return the
   * reasoning as ciphertext; replaying that ciphertext on the next request hands the chain of
   * thought back. Codex does exactly this against the same endpoint (issue #383 captured the
   * request), which is the evidence that the backend accepts both fields.
   *
   * **Why opt-in and not on for every `responses_api` provider.** `include` is a documented
   * Responses-API field, but `reasoning.context` is not part of the public Responses API surface —
   * it was observed on the ChatGPT Codex backend. A provider that validates its input strictly
   * answers an unknown key with `400`, which turns a cost optimisation into a total outage for that
   * provider. Scoping it to profiles that DECLARE support keeps every other provider's request
   * byte-identical to what it was, and makes enabling it a statement someone made about a specific
   * backend rather than a hope about all of them.
   */
  encryptedReasoning?: boolean;
  /**
   * usetheokit/theokit-sdk#383 — reasoning items captured from earlier rounds, keyed by the
   * `call_id` of the tool call each batch preceded.
   *
   * Keying on `call_id` is what keeps the replay ORDERED and self-correcting. The provider requires
   * a reasoning item to sit immediately before the output it produced, and the conversation history
   * the loop replays is the authority on which tool calls survived and in what order — so emitting
   * each batch just before its own `function_call` reproduces the original sequence without the
   * transport having to track conversation positions. A batch whose tool call is no longer in
   * history is simply never emitted.
   */
  reasoningByCallId?: ReadonlyMap<string, readonly ResponsesReasoningItem[]>;
}

/** Translate an `LlmMessage` into the Responses-API `input[]` items it contributes. */
// PRE-EXISTING debt, exposed when M75 fixed the Biome config that used to abort before
// sweeping these files (a nested root under refactor/). It is not new code and was not touched
// by M75; refactoring SDK internals without review would trade a visible problem for a diff
// risky. Tracked in usetheodev/theokit-sdk#151.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see the reason just above
function messageToInputItems(
  message: LlmMessage,
  reasoningByCallId?: ReadonlyMap<string, readonly ResponsesReasoningItem[]>,
): unknown[] {
  const items: unknown[] = [];
  if (message.role === "user") {
    const content: unknown[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "input_text", text: part.text });
      } else if (part.type === "image") {
        const url =
          part.source.type === "base64"
            ? `data:${part.source.media_type};base64,${part.source.data}`
            : part.source.url;
        content.push({ type: "input_image", image_url: url });
      } else if (part.type === "tool_result") {
        items.push({
          type: "function_call_output",
          call_id: part.toolUseId,
          output: toStringToolResultContent(part.content, "openai-responses", part.toolUseId),
        });
      }
    }
    if (content.length > 0) items.push({ role: "user", content });
    return items;
  }
  if (message.role === "assistant") {
    const content: unknown[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "output_text", text: part.text });
      } else if (part.type === "tool_use") {
        // usetheokit/theokit-sdk#383 — the reasoning that produced this call goes back FIRST. The
        // provider rejects a reasoning item that does not immediately precede its own output, so
        // replaying it here (rather than at the top of the message) is what keeps the sequence
        // valid when a round produced several calls.
        for (const reasoning of reasoningByCallId?.get(part.id) ?? []) {
          items.push({
            type: "reasoning",
            id: reasoning.id,
            encrypted_content: reasoning.encrypted_content,
            summary: [],
          });
        }
        items.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input),
        });
      }
    }
    if (content.length > 0) items.push({ role: "assistant", content });
    return items;
  }
  // system role rarely appears here (system travels on `request.system`); fold to text.
  const text = message.content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
  if (text.length > 0) items.push({ role: "system", content: text });
  return items;
}

/** Build the Responses-API request body from an `LlmRequest`. */
export function buildResponsesBody(
  request: LlmRequest,
  options: ResponsesBodyOptions = {},
): Record<string, unknown> {
  const input: unknown[] = [];
  for (const message of request.messages) {
    for (const item of messageToInputItems(message, options.reasoningByCallId)) input.push(item);
  }
  // The Responses API wants the BARE model id (`gpt-5.4`), never a `provider/model` id. The router
  // normally strips the provider prefix before the transport; strip here too as defense-in-depth so an
  // unstripped `openai-chatgpt/gpt-5.4` can never reach the backend as a 400 (decoupled from the router's
  // provider-inference heuristics).
  const slash = request.model.lastIndexOf("/");
  const model = slash >= 0 ? request.model.slice(slash + 1) : request.model;
  // `store: false` is a DECISION, not a leftover — usetheokit/theokit-sdk#383 asked for it to be
  // revisited and it stays `false`. Codex sends `true`, and the asymmetry between the two errors is
  // what settles it: `store: true` asks the provider to RETAIN the request server-side, and this
  // SDK's requests routinely carry a consumer's source code, file contents and shell output from
  // machines whose operator never agreed to that retention. Enabling it would silently widen where
  // that content lives. Turning it off costs nothing that #383 was about — `prompt_cache_key` is
  // what makes the prefix cacheable, and `include: ["reasoning.encrypted_content"]` is precisely
  // the mechanism for carrying reasoning forward WITHOUT server-side state. So the cheap error is
  // "we retained less than we could have" and the expensive one is "we retained a customer's source
  // code by default". There is no knob: a per-request override would be a privacy setting reachable
  // from a request builder, and nobody has asked for one.
  const body: Record<string, unknown> = { model, input, stream: true, store: false };
  const instructions = collapseSystemText(request.system);
  if (instructions.length > 0) body.instructions = instructions;
  if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const tools = (request.tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
  if (tools.length > 0) body.tools = tools;
  applyPromptCachingFields(body, request, options);
  return body;
}

/**
 * usetheokit/theokit-sdk#383 — the fields that decide whether a round is billed as a cache hit.
 *
 * Kept together and apart from the rest of the body because they answer one question ("what may the
 * provider reuse from the previous round?") and because the issue's measurement is about them and
 * nothing else: same provider, same model, same task, a third of our bytes, 2.8x our tokens.
 */
function applyPromptCachingFields(
  body: Record<string, unknown>,
  request: LlmRequest,
  options: ResponsesBodyOptions,
): void {
  const carryReasoning = options.encryptedReasoning === true;
  // `reasoning.context: "all_turns"` only ever extends an effort the caller already asked for. A
  // `reasoning` object holding nothing but `context` is a shape no captured request exhibits, and
  // inventing one to send to a strict backend is how an optimisation becomes a 400.
  if (request.reasoning !== undefined) {
    body.reasoning = {
      effort: request.reasoning.effort,
      ...(carryReasoning ? { context: "all_turns" } : {}),
    };
  }
  if (carryReasoning) body.include = ["reasoning.encrypted_content"];
  // The field the whole issue is about. Sent to every provider when the request carries a key:
  // `prompt_cache_key` is a documented Responses-API field of the same tier as `store` and `stream`,
  // which this transport has always sent unconditionally. Absent ⇒ omitted, so a caller that builds
  // a body by hand gets the pre-#383 request unchanged.
  if (request.promptCacheKey !== undefined) body.prompt_cache_key = request.promptCacheKey;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    /** usetheokit/theokit-sdk#383 — present on a `reasoning` item when `include` asked for it. */
    encrypted_content?: string;
  };
  response?: {
    usage?: {
      input_tokens?: number;
      /**
       * The slice of `input_tokens` the provider served from its prompt cache.
       *
       * Read because `input_tokens` INCLUDES it: a consumer adding input to output without
       * subtracting this reports tokens nobody is paying for. Measured 2026-08-25 with
       * `prompt_cache_key` in use — a three-round turn reported 9,835 where 619 were new, 16x.
       * The sibling Chat Completions transport has always read the equivalent
       * (`prompt_tokens_details.cached_tokens`); this one read the reasoning detail beside it and
       * skipped this one.
       */
      input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      output_tokens?: number;
      output_tokens_details?: { reasoning_tokens?: number };
    };
    error?: { message?: string };
  };
  message?: string;
}

/**
 * The SSE state machine of the Responses API, as a class rather than as one block inside the
 * generator.
 *
 * It is the same organisation `OpenAIStreamAccumulator` (openai.ts) already uses for the sibling
 * transport: the accumulated values are fields, each event kind is a small method, and the caller's
 * loop is `for await (…) yield* accumulator.consume(event)`. The suppression this replaces claimed
 * to be "mirroring OpenAIStreamAccumulator.consume" — it mirrored what that method DOES, not how it
 * is organised: `consume` is seven lines delegating to `applyChoice` / `applyUsage`, while this was
 * a 165-line block with ten mutable locals and eight else-if arms.
 *
 * `response.failed` / `error` stays with the caller on purpose. Reporting it needs `providerId` and
 * the response headers — facts about the REQUEST, which this object does not have and should not
 * grow a field for. {@link failureMessage} is how the caller recognises the arm.
 */
class ResponsesStreamAccumulator {
  private text = "";
  private readonly toolCalls: LlmToolCallPart[] = [];
  private stopReason: LlmStopReason = "end_turn";
  private inputTokens?: number;
  private outputTokens?: number;
  private reasoningTokens?: number;
  private cacheReadTokens?: number;
  private cacheWriteTokens?: number;
  /** Function-call accumulation keyed by the streamed output-item id. */
  private readonly pending: Record<string, { callId: string; name: string; args: string }> = {};
  /**
   * usetheokit/theokit-sdk#383 — reasoning items seen so far in THIS response and not yet claimed
   * by a tool call. Claimed (and cleared) when the next `function_call` completes, which is what
   * binds each batch to the call it produced.
   */
  private unclaimedReasoning: ResponsesReasoningItem[] = [];

  constructor(
    private readonly rememberReasoning: (
      callId: string,
      items: readonly ResponsesReasoningItem[],
    ) => void,
  ) {}

  /** The message of a terminal failure event, or `undefined` when this is not one. */
  static failureMessage(event: ResponsesEvent): string | undefined {
    if (event.type !== "response.failed" && event.type !== "error") return undefined;
    return event.response?.error?.message ?? event.message ?? "responses stream failed";
  }

  consume(event: ResponsesEvent): LlmEvent[] {
    // Two categories, asked in turn: the events that produce something for the caller to yield, and
    // the ones that only move state. `undefined` means "not mine", which keeps each half small
    // enough to read without counting braces.
    return this.applyDelta(event) ?? this.applyStructural(event) ?? [];
  }

  /** The three event kinds that produce an event for the consumer. */
  private applyDelta(event: ResponsesEvent): LlmEvent[] | undefined {
    const t = event.type;
    if (t === "response.output_text.delta") {
      const d = event.delta ?? "";
      if (d.length === 0) return [];
      this.text += d;
      return [{ type: "text_delta", text: d }];
    }
    if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") {
      const d = event.delta ?? "";
      return d.length > 0 ? [{ type: "reasoning_delta", text: d }] : [];
    }
    return undefined;
  }

  /** The event kinds that only move accumulator state. Routing only — each arm is its own method. */
  private applyStructural(event: ResponsesEvent): LlmEvent[] | undefined {
    const t = event.type;
    if (t === "response.output_item.added" || t === "response.output_item.done") {
      this.applyOutputItem(t, event);
      return [];
    }
    if (t === "response.function_call_arguments.delta") {
      this.appendArguments(event);
      return [];
    }
    if (t === "response.completed" || t === "response.incomplete") {
      this.applyTerminal(t, event);
      return [];
    }
    return undefined;
  }

  private appendArguments(event: ResponsesEvent): void {
    const c = event.item_id !== undefined ? this.pending[event.item_id] : undefined;
    if (c !== undefined) c.args += event.delta ?? "";
  }

  private applyTerminal(
    t: "response.completed" | "response.incomplete",
    event: ResponsesEvent,
  ): void {
    this.applyUsage(event.response?.usage);
    this.stopReason = t === "response.incomplete" ? "max_tokens" : "end_turn";
  }

  finish(): LlmFinish {
    // theokit#144: `stopReason` is returned on the finish value, not yielded as an event.
    const stopReason =
      this.toolCalls.length > 0 && this.stopReason === "end_turn" ? "tool_use" : this.stopReason;
    return makeLlmFinish({
      stopReason,
      text: this.text,
      toolCalls: this.toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
    });
  }

  private applyOutputItem(
    t: "response.output_item.added" | "response.output_item.done",
    event: ResponsesEvent,
  ): void {
    const item = event.item;
    if (item === undefined) return;
    if (t === "response.output_item.added") {
      if (item.type === "function_call") this.beginFunctionCall(item);
      return;
    }
    if (item.type === "reasoning") this.applyReasoningItem(item);
    else if (item.type === "function_call") this.applyFunctionCallDone(item);
  }

  private beginFunctionCall(item: NonNullable<ResponsesEvent["item"]>): void {
    const id = item.id ?? item.call_id ?? "call-0";
    this.pending[id] = {
      callId: item.call_id ?? id,
      name: item.name ?? "",
      args: item.arguments ?? "",
    };
  }

  private applyReasoningItem(item: NonNullable<ResponsesEvent["item"]>): void {
    const id = item.id;
    const encrypted = item.encrypted_content;
    // Both fields or neither: a reasoning item without ciphertext cannot be replayed, and one
    // without an id cannot be addressed. Requesting `include` is what makes them appear, so their
    // absence here is the normal shape for a provider that ignored the field.
    if (id !== undefined && encrypted !== undefined && encrypted.length > 0) {
      this.unclaimedReasoning.push({ id, encrypted_content: encrypted });
    }
  }

  private applyFunctionCallDone(item: NonNullable<ResponsesEvent["item"]>): void {
    const id = item.id ?? item.call_id ?? "call-0";
    const c = this.pending[id] ?? {
      callId: item.call_id ?? id,
      name: item.name ?? "",
      args: item.arguments ?? "",
    };
    const call: LlmToolCallPart = {
      type: "tool_use",
      id: c.callId,
      name: c.name.length > 0 ? c.name : (item.name ?? ""),
      input: parseToolArguments(item.arguments ?? c.args),
    };
    // theokit#144: the call is carried by `LlmFinish.toolCalls`. It used to also be yielded as a
    // `tool_use` event that no consumer read — see the `LlmEvent` docblock for why the live tool
    // channel is `onDelta`, not this stream.
    this.toolCalls.push(call);
    if (this.unclaimedReasoning.length > 0) {
      this.rememberReasoning(call.id, this.unclaimedReasoning);
      this.unclaimedReasoning = [];
    }
    delete this.pending[id];
  }

  private applyUsage(usage: NonNullable<ResponsesEvent["response"]>["usage"]): void {
    if (usage === undefined) return;
    this.inputTokens = usage.input_tokens;
    this.outputTokens = usage.output_tokens;
    this.reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
    this.cacheReadTokens = usage.input_tokens_details?.cached_tokens;
    this.cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens;
  }
}

/**
 * usetheokit/theokit-sdk#383 — cap on how many tool calls' reasoning one client remembers.
 *
 * The client instance outlives a turn, so without a cap a long-lived run accumulates ciphertext for
 * every tool call it ever made. Evicting oldest-first is safe: a batch is only ever read on the
 * round immediately after the one that produced it, so an entry old enough to evict is an entry
 * whose tool call is far enough back in history that dropping it costs a re-derivation at worst.
 */
const MAX_REMEMBERED_REASONING_CALLS = 256;

export class ResponsesApiClient implements LlmClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /**
   * usetheokit/theokit-sdk#383 — reasoning ciphertext captured from earlier rounds, keyed by the
   * `call_id` it preceded. Held on the CLIENT rather than threaded through `LlmRequest` because a
   * round's reasoning is provider-shaped ciphertext with a provider-shaped ordering rule; the agent
   * loop has no use for it and the same client instance serves every round of a turn. Insertion
   * order is the eviction order (see {@link MAX_REMEMBERED_REASONING_CALLS}).
   */
  private readonly reasoningByCallId = new Map<string, ResponsesReasoningItem[]>();

  constructor(private readonly options: ResponsesApiClientOptions) {
    this.name = options.providerName ?? "openai-responses";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * usetheokit/theokit-sdk#383 — bind a batch of reasoning ciphertext to the tool call it produced,
   * evicting the oldest binding once the cap is reached.
   */
  private rememberReasoning(callId: string, items: readonly ResponsesReasoningItem[]): void {
    this.reasoningByCallId.set(callId, [...items]);
    while (this.reasoningByCallId.size > MAX_REMEMBERED_REASONING_CALLS) {
      const oldest = this.reasoningByCallId.keys().next();
      if (oldest.done === true) break;
      this.reasoningByCallId.delete(oldest.value);
    }
  }

  /** Issues the streaming request. Separated so `stream()` reads as fetch → check → consume. */
  private async post(request: LlmRequest, signal: AbortSignal): Promise<Response> {
    return await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${this.options.apiKey}`,
        ...(this.options.extraHeaders ?? {}),
      },
      body: JSON.stringify(
        // Both options ride the SAME flag on purpose: a provider that never declared support gets
        // the byte-identical pre-#383 body, even in the impossible case where it returned ciphertext
        // nobody asked for.
        buildResponsesBody(
          request,
          this.options.encryptedReasoning === true
            ? { encryptedReasoning: true, reasoningByCallId: this.reasoningByCallId }
            : {},
        ),
      ),
    });
  }

  /** Maps a non-2xx response to a typed error. Returns it rather than throwing, so the caller's
   * control flow stays visible at the call site. */
  private async errorFor(response: Response, providerId: string): Promise<Error> {
    const text = await response.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return mapOpenAICompatibleError({
      providerId,
      status: response.status,
      body,
      headers: response.headers,
      endpoint: "/responses",
    });
  }

  /**
   * SSE frames → parsed events, stopping at `[DONE]`. A frame that is not JSON is skipped rather
   * than fatal: a provider that emits a keep-alive or a comment frame must not end the response.
   */
  private async *decode(
    body: NonNullable<Response["body"]>,
    signal: AbortSignal,
  ): AsyncGenerator<ResponsesEvent, void, void> {
    for await (const record of parseSseStream(body, signal)) {
      if (record.data === "[DONE]") return;
      let event: ResponsesEvent;
      try {
        event = JSON.parse(record.data) as ResponsesEvent;
      } catch {
        continue;
      }
      yield event;
    }
  }

  async *stream(
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmEvent, LlmFinish, void> {
    const providerId = this.options.providerName ?? "openai";
    const response = await this.post(request, signal);
    if (!response.ok) throw await this.errorFor(response, providerId);

    const acc = new ResponsesStreamAccumulator((callId, items) =>
      this.rememberReasoning(callId, items),
    );

    if (response.body !== null) {
      for await (const event of this.decode(response.body, signal)) {
        const failure = ResponsesStreamAccumulator.failureMessage(event);
        if (failure !== undefined) {
          // Never echo a raw provider body — report the message only, then map to a typed error.
          // The event is the consumer's copy of the message; the throw is what stops the loop.
          yield { type: "error", message: failure };
          throw mapOpenAICompatibleError({
            providerId,
            status: 502,
            body: { error: { message: failure } },
            headers: response.headers,
            endpoint: "/responses",
          });
        }
        yield* acc.consume(event);
      }
    }

    return acc.finish();
  }
}
