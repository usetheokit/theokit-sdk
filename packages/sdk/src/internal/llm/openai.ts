/**
 * Real OpenAI Chat Completions client. Streams `/v1/chat/completions` and
 * translates delta chunks into our provider-agnostic `LlmEvent`s.
 *
 * Uses native `fetch` only — no `openai` SDK dependency.
 *
 * @internal
 */

import { NetworkError } from "../../errors.js";
import { diag } from "../diagnostics.js";
import { mapOllamaHttpError, mapOllamaTransportError } from "../error-mappers/ollama.js";
import { mapOpenAICompatibleError } from "../error-mappers/openai-compatible.js";
import { readErrorResponseBody } from "../http.js";
import { boundFetch } from "../runtime-fetch.js";
import {
  collapseSystemText,
  makeLlmFinish,
  mapOpenAIFinish,
  parseToolArguments,
} from "./finish.js";
import { extractHermesToolCalls, StreamSuppressionBuffer } from "./hermes-tool-extract.js";
import { toOpenAIMessages } from "./openai-messages.js";
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
 * M45 — derive the chat-completions path from the baseUrl: a path already carrying a version segment
 * (`/v1`, `/v1beta`, …) gets `/chat/completions`; host-only (or unparseable) baseUrls keep the legacy
 * `/v1/chat/completions`. Unparseable NEVER throws (H1) — the transport surfaces a typed error at fetch time.
 */
function deriveChatPath(baseUrl: string): string {
  try {
    return /\/v\d+[a-z]*(\/|$)/.test(new URL(baseUrl).pathname)
      ? "/chat/completions"
      : "/v1/chat/completions";
  } catch {
    return "/v1/chat/completions";
  }
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  fetch?: typeof fetch;
  /**
   * Provider name for error mapping dispatch (T1.1, ADR D185). When set
   * to `"ollama"`, transport and HTTP errors go through `mapOllamaTransportError`
   * / `mapOllamaHttpError` for actionable messages before falling back to
   * the generic OpenAI-compatible mapper. Default `"openai"`.
   */
  providerName?: string;
  /**
   * Opt-in leaked-dialect safe-parse (theokit#58 follow-up). When `true`, a finish that carries
   * ZERO native `tool_calls` has its assistant text scanned for the Hermes `<function=…></tool_call>`
   * dialect; any recovered calls are surfaced as real `tool_calls` so the loop executes them.
   * Default `false` — a code assistant can legitimately print a literal `<function=` in code text.
   */
  extractToolCallsFromContent?: boolean;
  /**
   * M41 — extra HTTP headers merged into the request (the profile's static `extraHeaders` + a provider
   * `transform.headers(ctx)`). Spread AFTER the base `authorization`/`content-type`, so a provider that owns
   * its auth CAN override them by design (document this on `ProviderTransform.headers`).
   */
  extraHeaders?: Record<string, string>;
  /** M45 — explicit chat-completions path (from `ProviderProfile.chatCompletionsPath`). */
  chatCompletionsPath?: string;
}

interface OpenAIDeltaChunk {
  choices?: Array<{
    index: number;
    delta?: {
      content?: string;
      /** OpenRouter unified reasoning delta (issue #47) — streamed separately from `content`. */
      reasoning?: string;
      /**
       * Sibling reasoning field used by some OpenAI-compatible providers (DeepSeek's direct API,
       * many vLLM / LMStudio reasoning parsers). Treated identically to `reasoning` (issue #47,
       * F-domain-2). OpenRouter normalizes to `reasoning`; this is the fallback for non-OpenRouter
       * compat endpoints reached via `baseUrl` override.
       */
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * OpenAI + OpenRouter extended usage (D376). Anthropic prompt caching
     * surfaces as `prompt_tokens_details.cached_tokens` on OpenRouter passthrough;
     * native OpenAI exposes the same field on `chatcmpl-*` responses.
     */
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    /** Anthropic-on-OpenRouter passes cache_creation_tokens top-level (a peer#10266). */
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /**
   * In-stream provider error. OpenRouter (and some OpenAI-compatible proxies)
   * report auth / quota / rate-limit failures as an HTTP 200 SSE body carrying
   * `data: {"error":{"message":"...","code":401}}` instead of a non-2xx status.
   * Without surfacing this, the round finishes empty and the failure is silent
   * (usetheodev/theocode#31).
   */
  error?: { message?: string; code?: number | string; type?: string };
}

export class OpenAIClient implements LlmClient {
  readonly name = "openai";
  private readonly baseUrl: string;
  private readonly chatPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIClientOptions) {
    // M45 review M3 — strip trailing slashes so `…/v1/` (the python-openai-popularized form) joins cleanly.
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    // M45 — URL-join rule (kills the /v1/v1 doubling): explicit override > version-segment detection >
    // legacy `/v1/chat/completions`. A baseUrl already carrying a version path segment (…/openai/v1,
    // …/v1beta/openai) gets only `/chat/completions`; host-only baseUrls are byte-identical to before.
    // M45 review H1 — the parse NEVER throws from the constructor: a malformed baseUrl (scheme-less host,
    // empty env var) degrades to the LEGACY path (byte-identical to pre-M45 string concat) and fails, typed,
    // at the first fetch — never poisoning the whole provider chain at construction time.
    this.chatPath = options.chatCompletionsPath ?? deriveChatPath(this.baseUrl);
    this.fetchImpl = boundFetch(options.fetch);
  }

  /**
   * Whether this client recovers leaked Hermes tool-call dialect from assistant
   * text (theokit#58 follow-up). Observability for the route→client wiring of
   * `extractToolCallsFromContent`. @internal
   */
  get recoversLeakedToolCalls(): boolean {
    return this.options.extractToolCallsFromContent ?? false;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: HTTP+SSE handshake + accumulator is intentionally one block
  async *stream(
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmEvent, LlmFinish, void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.options.apiKey}`,
    };
    if (this.options.organization !== undefined) {
      headers["openai-organization"] = this.options.organization;
    }
    // M41 — merge extra/dynamic headers (spread last: a provider that owns its auth may override base headers).
    if (this.options.extraHeaders !== undefined) Object.assign(headers, this.options.extraHeaders);
    const providerId = this.options.providerName ?? this.name;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${this.chatPath}`, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(buildOpenAIBody(request, providerId)),
      });
    } catch (fetchErr) {
      // T1.1: Ollama-specific transport error mapping (ECONNREFUSED / ENOTFOUND).
      const mapped = mapOllamaTransportError({
        providerId,
        cause: fetchErr,
        endpoint: "/v1/chat/completions",
      });
      if (mapped !== undefined) throw mapped;
      // M93 — before this, a raw `throw fetchErr` left here for every provider other than Ollama, and
      // a foreign error is NON-transient by contract (`errors.ts:429`): retry stayed off
      // in the most classic case.
      throw wrapTransportError(fetchErr, { providerId, endpoint: "/v1/chat/completions" });
    }
    if (!response.ok) {
      const body = await readErrorResponseBody(response);
      // T1.1: try Ollama-specific HTTP mapper first; falls through to generic.
      const ollamaMapped = mapOllamaHttpError({
        providerId,
        status: response.status,
        body,
        headers: response.headers,
        endpoint: "/v1/chat/completions",
      });
      if (ollamaMapped !== undefined) throw ollamaMapped;
      // Use the openai-compatible mapper. For OpenAI proper the providerId
      // is "openai"; OpenRouter is handled in its own client subclass (see
      // OpenRouterClient if/when added). Providers tagged differently via
      // wrapper clients can pass their own providerId by overriding.
      throw mapOpenAICompatibleError({
        providerId,
        status: response.status,
        body,
        headers: response.headers,
        endpoint: "/v1/chat/completions",
      });
    }

    const accumulator = new OpenAIStreamAccumulator(
      this.options.extractToolCallsFromContent ?? false,
      providerId,
      // R5: request-scoped allowlist — leaked recovery only promotes a block whose name is a tool the
      // model was actually given. Empty set (no tools) recovers nothing.
      new Set(request.tools?.map((tool) => tool.name) ?? []),
    );
    let sawDone = false;
    // #371 — reading the BODY can fail too (socket destroyed mid-stream), and only the initial
    // `fetch` was wrapped. Undici's raw "terminated" reached the caller with no provider, no
    // endpoint and `code: undefined`, while every other transport failure on this path reads
    // "openai transport failure on /v1/chat/completions: …" and carries `transport_failure`. The
    // wrapper returns any SDK error untouched, so an in-stream provider error keeps its own mapping.
    const records = (async function* () {
      try {
        yield* parseSseStream(response.body, signal);
      } catch (readErr) {
        throw wrapTransportError(readErr, { providerId, endpoint: "/v1/chat/completions" });
      }
    })();
    for await (const record of records) {
      if (record.data === "[DONE]") {
        sawDone = true;
        break;
      }
      let chunk: OpenAIDeltaChunk;
      try {
        chunk = JSON.parse(record.data) as OpenAIDeltaChunk;
      } catch {
        continue;
      }
      // Fail-loud on an in-stream provider error (OpenRouter HTTP-200 error body).
      // The accumulator only reads `choices`, so an error-only chunk would finish
      // the round empty and swallow the failure (theocode#31). Map it to the same
      // typed error a non-2xx HTTP status would have produced.
      if (chunk.error !== undefined && chunk.error !== null) {
        const status = typeof chunk.error.code === "number" ? chunk.error.code : 502;
        throw mapOpenAICompatibleError({
          providerId,
          status,
          body: chunk,
          headers: response.headers,
          endpoint: "/v1/chat/completions",
        });
      }
      const events = accumulator.consume(chunk);
      for (const event of events) yield event;
    }
    // M2 #61 — a stream ending with NEITHER `[DONE]` NOR a `finish_reason` was
    // truncated (dropped connection / proxy hiccup); throw a typed error rather
    // than commit the partial turn as a clean `end_turn` (codex prior art).
    if (!sawDone && !accumulator.finishReasonSeen) {
      throw new NetworkError("SSE stream truncated (no finish_reason / [DONE])", {
        code: "stream_truncated",
      });
    }
    // R7: drain any held buffer so leaked-dialect text is never silently dropped.
    const drainEvent = accumulator.finalizeHeldText();
    if (drainEvent !== undefined) yield drainEvent;
    return accumulator.finish();
  }
}

class OpenAIStreamAccumulator {
  private text = "";
  private stopReason: LlmStopReason = "end_turn";
  private inputTokens?: number;
  private outputTokens?: number;
  private cacheReadTokens?: number;
  private cacheWriteTokens?: number;
  private reasoningTokens?: number;
  private readonly toolCalls = new Map<number, { id: string; name: string; args: string }>();
  /** R7: present only when recovery is enabled AND the request declares tools — holds suspected
   *  leaked-dialect content back from the `text_delta` stream. `undefined` ⇒ stream immediately. */
  private readonly suppress?: StreamSuppressionBuffer;

  /**
   * @param extractFromContent opt-in leaked-dialect safe-parse (theokit#58). Default false.
   * @param providerName provider id, used only to label the recovery log line.
   * @param allowedToolNames R5 request-scoped allowlist — built from `request.tools` at `stream()`;
   *   leaked recovery in `finish()` only promotes a block whose name is in this set. `undefined`
   *   (direct construction) recovers all (back-compat); an empty set recovers nothing.
   */
  constructor(
    private readonly extractFromContent = false,
    private readonly providerName = "openai",
    private readonly allowedToolNames?: ReadonlySet<string>,
  ) {
    this.suppress =
      extractFromContent && allowedToolNames !== undefined && allowedToolNames.size > 0
        ? new StreamSuppressionBuffer(allowedToolNames)
        : undefined;
  }

  consume(chunk: OpenAIDeltaChunk): LlmEvent[] {
    const events: LlmEvent[] = [];
    this.applyUsage(chunk.usage);
    for (const choice of chunk.choices ?? []) {
      events.push(...this.applyChoice(choice));
    }
    return events;
  }

  private applyChoice(choice: NonNullable<OpenAIDeltaChunk["choices"]>[number]): LlmEvent[] {
    const events: LlmEvent[] = [];
    // issue #47: reasoning delta precedes the visible text in arrival order. OpenRouter streams it
    // as `reasoning`; some compat providers use `reasoning_content` (F-domain-2) — accept either.
    const reasoningEvent = this.applyReasoningDelta(
      choice.delta?.reasoning ?? choice.delta?.reasoning_content,
    );
    if (reasoningEvent !== undefined) events.push(reasoningEvent);
    const textEvent = this.applyContentDelta(choice.delta?.content);
    if (textEvent !== undefined) events.push(textEvent);
    this.mergeToolCallDeltas(choice.delta?.tool_calls);
    this.applyFinishReason(choice.finish_reason);
    // R7: at the terminal chunk, flush the held buffer's residual (held minus recoverable blocks)
    // AFTER this chunk's content was appended above — so `accumulatedText == finish.text`.
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      const flushEvent = this.finalizeHeldText();
      if (flushEvent !== undefined) events.push(flushEvent);
    }
    return events;
  }

  private applyReasoningDelta(reasoning: string | undefined): LlmEvent | undefined {
    // issue #47: reasoning is NOT accumulated into `this.text` (the visible answer) — it is a
    // separate channel surfaced as `reasoning_delta` (→ thinking events at the loop layer).
    if (typeof reasoning !== "string" || reasoning.length === 0) return undefined;
    return { type: "reasoning_delta", text: reasoning };
  }

  private applyUsage(usage: OpenAIDeltaChunk["usage"]): void {
    if (usage?.prompt_tokens !== undefined) this.inputTokens = usage.prompt_tokens;
    if (usage?.completion_tokens !== undefined) this.outputTokens = usage.completion_tokens;
    // D376: cache + reasoning buckets via OpenRouter passthrough + OpenAI native.
    const cachedDetail = usage?.prompt_tokens_details?.cached_tokens;
    if (cachedDetail !== undefined) this.cacheReadTokens = cachedDetail;
    const reasoningDetail = usage?.completion_tokens_details?.reasoning_tokens;
    if (reasoningDetail !== undefined) this.reasoningTokens = reasoningDetail;
    // a peer#10266 top-level fallback for Anthropic-on-OpenRouter.
    if (usage?.cache_read_input_tokens !== undefined) {
      this.cacheReadTokens = usage.cache_read_input_tokens;
    }
    if (usage?.cache_creation_input_tokens !== undefined) {
      this.cacheWriteTokens = usage.cache_creation_input_tokens;
    }
  }

  private applyContentDelta(content: string | undefined): LlmEvent | undefined {
    if (typeof content !== "string" || content.length === 0) return undefined;
    this.text += content;
    // R7: when suppression is active, HOLD content that could still be a leaked tool call (the buffer
    // returns the text to emit now, or `undefined` to hold). Otherwise stream immediately.
    if (this.suppress === undefined) return { type: "text_delta", text: content };
    const emit = this.suppress.push(content);
    return emit !== undefined ? { type: "text_delta", text: emit } : undefined;
  }

  /** R7 held-buffer finalizer, called at the `finish_reason` chunk (in `applyChoice`) AND after the
   *  SSE loop in `stream()` — so a stream that omits a `finish_reason` terminal never silently drops
   *  held text. `toolCalls.size > 0` (native calls present) makes `finish()` skip recovery, so the
   *  buffer streams the held text whole. Idempotent once drained. */
  finalizeHeldText(): LlmEvent | undefined {
    const emit = this.suppress?.drain(this.toolCalls.size > 0);
    return emit !== undefined ? { type: "text_delta", text: emit } : undefined;
  }

  private mergeToolCallDeltas(
    deltas: NonNullable<NonNullable<OpenAIDeltaChunk["choices"]>[number]["delta"]>["tool_calls"],
  ): void {
    for (const call of deltas ?? []) {
      const existing = this.toolCalls.get(call.index) ?? { id: "", name: "", args: "" };
      if (call.id !== undefined) existing.id = call.id;
      if (call.function?.name !== undefined) existing.name = call.function.name;
      if (call.function?.arguments !== undefined) existing.args += call.function.arguments;
      this.toolCalls.set(call.index, existing);
    }
  }

  /** M2 #61 — true once any chunk carried a non-null `finish_reason` (else a
   *  stream ending without `[DONE]` is a truncation, not a clean end). */
  private sawFinishReason = false;
  get finishReasonSeen(): boolean {
    return this.sawFinishReason;
  }

  private applyFinishReason(reason: string | null | undefined): void {
    if (reason === undefined || reason === null) return;
    this.sawFinishReason = true;
    this.stopReason = mapOpenAIFinish(reason);
  }

  finish(): LlmFinish {
    const toolCalls: LlmToolCallPart[] = [];
    for (const call of this.toolCalls.values()) {
      const input = parseToolArguments(call.args);
      toolCalls.push({ type: "tool_use", id: call.id, name: call.name, input });
    }
    let text = this.text;
    let stopReason = this.stopReason;
    // theokit#58 follow-up: leaked-dialect safe-parse. Opt-in, and ONLY when the provider sent no
    // native tool_calls (the size-guard prevents double-counting a real call). Recovered calls flip
    // the stopReason to "tool_use" so the agent loop dispatches them; the consumed dialect is stripped
    // from the visible text.
    if (this.extractFromContent && toolCalls.length === 0) {
      const recovered = extractHermesToolCalls(
        this.text,
        () => `hermes-${globalThis.crypto.randomUUID()}`,
        this.allowedToolNames,
      );
      if (recovered.toolCalls.length > 0) {
        toolCalls.push(...recovered.toolCalls);
        text = recovered.residualText;
        stopReason = "tool_use";
        // Observability (wiring triad pillar c): recovery is a model-misbehavior workaround, so make
        // it visible — a route that leaks often should be diagnosable without a debugger.
        diag(
          `[theokit-sdk] recovered ${recovered.toolCalls.length} leaked tool call(s) from assistant content ` +
            `(provider="${this.providerName}", names=${recovered.toolCalls.map((c) => c.name).join(",")})\n`,
        );
      }
      // R5 observability: a leaked block DROPPED by the request-scoped allowlist is the guard firing —
      // surface it too, so a model emitting `<function=NAME>` for an undeclared tool is diagnosable.
      if (recovered.droppedNames.length > 0) {
        diag(
          `[theokit-sdk] dropped ${recovered.droppedNames.length} leaked block(s) whose name is not a ` +
            `tool in the request (provider="${this.providerName}", names=${recovered.droppedNames.join(",")})\n`,
        );
      }
    }
    return makeLlmFinish({
      stopReason,
      text,
      toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      reasoningTokens: this.reasoningTokens,
    });
  }
}

/**
 * issue #47 / F-domain-1: encode the reasoning request in the shape the target provider accepts.
 * Native OpenAI Chat Completions rejects unknown body params and expects the top-level
 * `reasoning_effort` string; OpenRouter (and OpenAI-compatible passthroughs) use the unified
 * `reasoning: { effort }` object. `stream()` always passes the resolved provider id, so a native
 * OpenAI request never 400s on the OpenRouter shape. When `providerName` is unspecified (test seam),
 * the unified object is used — the broader-compatibility default.
 */
function applyReasoningRequest(
  body: Record<string, unknown>,
  effort: string,
  providerName: string | undefined,
): void {
  if (providerName === "openai") {
    body.reasoning_effort = effort;
    return;
  }
  body.reasoning = { effort };
}

/**
 * Encode the `tools` array + per-request `tool_choice` gate (step-cap force-close). `tool_choice`
 * is meaningful only alongside `tools`, so both are emitted together (or neither). `"none"` advertises
 * the tools but forbids calling them — forcing a text answer from an agent whose tools are registered.
 */
function applyToolsRequest(body: Record<string, unknown>, request: LlmRequest): void {
  if (request.tools === undefined || request.tools.length === 0) return;
  body.tools = request.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
}

function buildOpenAIBody(request: LlmRequest, providerName?: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const systemText = openAISystemText(request.system);
  if (systemText.length > 0) {
    messages.push({ role: "system", content: systemText });
  }
  for (const message of request.messages) {
    for (const out of toOpenAIMessages(message)) messages.push(out);
  }
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    // D376: opt-in to OpenAI's final-chunk usage record (no-op for providers
    // that don't honor it; OpenRouter / OpenAI both respect it).
    stream_options: { include_usage: true },
    messages,
  };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  // issue #47: reasoning request — only when an effort was requested. Provider-specific wire shape.
  if (request.reasoning?.effort !== undefined)
    applyReasoningRequest(body, request.reasoning.effort, providerName);
  applyToolsRequest(body, request);
  const responseFormat = encodeOpenAIResponseFormat(request.responseFormat);
  if (responseFormat !== undefined) body.response_format = responseFormat;
  return body;
}

/**
 * T3.5 follow-up — collapse `LlmRequest.system` to the OpenAI wire shape
 * (single string).
 *
 * @internal
 */
const openAISystemText = collapseSystemText;

/**
 * T3.6 — encode `LlmResponseFormat` into the OpenAI wire shape. The
 * structured-outputs path defaults `strict` to `true` (provider guarantees
 * the response matches the schema).
 *
 * @internal
 */
function encodeOpenAIResponseFormat(
  rf: LlmRequest["responseFormat"],
): Record<string, unknown> | undefined {
  if (rf === undefined) return undefined;
  if (rf.type === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: rf.jsonSchema.name,
      schema: rf.jsonSchema.schema,
      strict: rf.jsonSchema.strict ?? true,
    },
  };
}

/**
 * T3.6 — public test seam for `buildOpenAIBody`. The implementation is
 * file-local; the seam lets unit tests verify the wire shape without
 * exercising the streaming path.
 *
 * @internal
 */
export const __testing__buildOpenAIBody = buildOpenAIBody;
/** issue #47 test seam — exercise reasoning-delta parsing without a live stream. */
export const __testing__OpenAIStreamAccumulator = OpenAIStreamAccumulator;
