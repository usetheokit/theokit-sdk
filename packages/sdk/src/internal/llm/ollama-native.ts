/**
 * Ollama native API client (T8.1 follow-up, ADR D191).
 *
 * Targets Ollama's native `/api/chat` endpoint with NDJSON streaming.
 * Critical for **tool calling** — per peer-project upstream warning, the
 * OpenAI-compat `/v1/chat/completions` endpoint BREAKS tool calling in
 * Ollama (models emit raw tool JSON as text instead of structured
 * `tool_calls` blocks). Mirrors peer-project `extensions/ollama/src/stream.ts`.
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
import { mapOllamaHttpError, mapOllamaTransportError } from "../error-mappers/ollama.js";
import { mapOpenAICompatibleError } from "../error-mappers/openai-compatible.js";
import { collapseSystemText, makeLlmFinish } from "./finish.js";
import { toStringToolResultContent } from "./tool-result-content.js";
import { wrapTransportError } from "./transport-error.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmMessage,
  LlmRequest,
  LlmStopReason,
  LlmToolCallPart,
} from "./types.js";

export interface OllamaNativeClientOptions {
  /** Optional API key for Ollama Cloud / reverse-proxy. Local Ollama ignores `Authorization`. */
  apiKey?: string;
  /** Base URL. Default `http://localhost:11434`. `/v1` suffix is stripped automatically. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaChatChunk {
  message?: {
    role?: "assistant";
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class OllamaNativeClient implements LlmClient {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OllamaNativeClientOptions) {
    // Strip `/v1` if user mistakenly included it (peer-project guard).
    const raw = (options.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.baseUrl = raw.replace(/\/v1$/i, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: HTTP+NDJSON handshake + accumulator is intentionally one block (mirrors openai.ts)
  async *stream(
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmEvent, LlmFinish, void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    const body = buildOllamaChatBody(request);
    const url = `${this.baseUrl}/api/chat`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      const mapped = mapOllamaTransportError({
        providerId: "ollama",
        cause: fetchErr,
        endpoint: "/api/chat",
      });
      if (mapped !== undefined) throw mapped;
      // A raw fetch error must NOT leave this file. `isTransientError` is
      // `err instanceof TheokitAgentError && err.isRetryable`, and router.ts wraps every resolved
      // client in RetryingLlmClient — so a foreign error is non-transient BY CONTRACT and a dropped
      // connection to a local Ollama, the most ordinary transient failure there is, was never
      // retried. openai.ts:183 records this same bug being fixed for the other transports and names
      // Ollama as the one that still had it. `wrapTransportError` passes AbortError and any
      // TheokitAgentError through untouched, so it cannot relabel an already-mapped provider error.
      throw wrapTransportError(fetchErr, { providerId: "ollama", endpoint: "/api/chat" });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let bodyJson: unknown = text;
      try {
        bodyJson = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const mapped = mapOllamaHttpError({
        providerId: "ollama",
        status: response.status,
        body: bodyJson,
        headers: response.headers,
        endpoint: "/api/chat",
      });
      if (mapped !== undefined) throw mapped;
      // A status the Ollama body dialect does not recognise still has an HTTP meaning, and that
      // meaning lives in ONE place — the shared RFC 9110 ladder the four provider mappers delegate
      // to. Reaching for it here rather than writing a sixth copy is the point of that unification;
      // a bare `new Error` would be outside the hierarchy exactly like the raw fetch error above.
      throw mapOpenAICompatibleError({
        providerId: "ollama",
        status: response.status,
        body: bodyJson,
        headers: response.headers,
        endpoint: "/api/chat",
      });
    }

    const accumulator = new OllamaStreamAccumulator();
    if (response.body === null) {
      return accumulator.finish();
    }
    for await (const chunk of parseNdjsonStream(response.body, signal)) {
      const events = accumulator.consume(chunk);
      for (const event of events) yield event;
      if (chunk.done === true) break;
    }
    return accumulator.finish();
  }
}

class OllamaStreamAccumulator {
  private text = "";
  private stopReason: LlmStopReason = "end_turn";
  private inputTokens?: number;
  private outputTokens?: number;
  private readonly toolCalls: LlmToolCallPart[] = [];

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: NDJSON chunk dispatch — text delta + tool_call append + finish-reason mapping is one cohesive accumulator (mirrors openai.ts OpenAIStreamAccumulator.consume).
  consume(chunk: OllamaChatChunk): LlmEvent[] {
    const events: LlmEvent[] = [];
    if (chunk.prompt_eval_count !== undefined) this.inputTokens = chunk.prompt_eval_count;
    if (chunk.eval_count !== undefined) this.outputTokens = chunk.eval_count;
    const msg = chunk.message;
    if (msg?.content !== undefined && msg.content.length > 0) {
      this.text += msg.content;
      events.push({ type: "text_delta", text: msg.content });
    }
    if (msg?.tool_calls !== undefined) {
      for (const call of msg.tool_calls) {
        const input =
          typeof call.function.arguments === "string"
            ? parseOllamaToolArguments(call.function.arguments)
            : call.function.arguments;
        this.toolCalls.push({
          type: "tool_use",
          id: `ollama_call_${this.toolCalls.length + 1}`,
          name: call.function.name,
          input,
        });
      }
    }
    if (chunk.done === true && chunk.done_reason !== undefined) {
      this.stopReason = mapOllamaDoneReason(chunk.done_reason, this.toolCalls.length > 0);
    }
    return events;
  }

  finish(): LlmFinish {
    if (this.toolCalls.length > 0 && this.stopReason === "end_turn") {
      this.stopReason = "tool_use";
    }
    return makeLlmFinish({
      stopReason: this.stopReason,
      text: this.text,
      toolCalls: this.toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    });
  }
}

function parseOllamaToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapOllamaDoneReason(reason: string, hasToolCalls: boolean): LlmStopReason {
  if (hasToolCalls) return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  return "end_turn";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: NDJSON line buffering + JSON.parse-with-skip-malformed + signal abort + trailing-buffer flush is one cohesive parser, mirrors peer-project's parseJsonLineStream.
async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<OllamaChatChunk, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          yield JSON.parse(trimmed) as OllamaChatChunk;
        } catch {
          /* skip malformed NDJSON line */
        }
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      try {
        yield JSON.parse(tail) as OllamaChatChunk;
      } catch {
        /* ignore */
      }
    }
  } finally {
    // T3.2 + T3.3 — mirror sse.ts: cancel the underlying body stream on
    // every exit path (abort, normal close, consumer break, consumer
    // throw). Without this the upstream Ollama HTTP TCP socket stays in
    // CLOSE_WAIT until the OS times it out. cancel() on a finished stream
    // is a no-op so always-cancel is safe.
    try {
      await reader.cancel();
    } catch {
      // best-effort — already cancelled OR upstream closed
    }
    reader.releaseLock();
  }
}

/**
 * T3.5 — collapse the wider `LlmRequest.system` shape into the legacy
 * single-string form Ollama expects.
 *
 * @internal
 */
const ollamaSystemText = collapseSystemText;

function buildOllamaChatBody(request: LlmRequest): Record<string, unknown> {
  const messages: OllamaChatMessage[] = [];
  const systemText = ollamaSystemText(request.system);
  if (systemText.length > 0) {
    messages.push({ role: "system", content: systemText });
  }
  for (const message of request.messages) {
    for (const out of toOllamaMessages(message)) messages.push(out);
  }
  const tools = toOllamaTools(request.tools);
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    messages,
    // ADR D192: 24h keep_alive prevents Ollama from evicting the chat model
    // when other models (embeddings, judges) are loaded between turns.
    // Cuts cold-load latency from 20-30s to single-digit ms per turn.
    keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "24h",
  };
  if (tools.length > 0) body.tools = tools;
  const opts: Record<string, unknown> = {};
  if (request.maxTokens !== undefined) opts.num_predict = request.maxTokens;
  if (request.temperature !== undefined) opts.temperature = request.temperature;
  if (Object.keys(opts).length > 0) body.options = opts;
  return body;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 3-role transformation (system/user/assistant) with tool_result→tool role demotion + tool_use→tool_calls promotion is one cohesive mapper; splitting hurts readability.
function toOllamaMessages(message: LlmMessage): OllamaChatMessage[] {
  if (message.role === "system") {
    return [{ role: "system", content: joinTextParts(message) }];
  }
  if (message.role === "user") {
    // M35 — the ollama-native wire has no image content channel here. Fail fast rather than silently
    // dropping an attached image (error-handling.md: no silent drop); OpenAI/OpenRouter carries images.
    if (message.content.some((p) => p.type === "image")) {
      throw new ConfigurationError(
        "image input is not supported on the ollama-native provider; use an OpenAI/OpenRouter model for multimodal turns",
        { code: "ollama_image_unsupported" },
      );
    }
    const out: OllamaChatMessage[] = [];
    for (const part of message.content) {
      if (part.type === "tool_result") {
        out.push({
          role: "tool",
          // SE7 — string-only tool role: text blocks flatten; image fails fast.
          content: toStringToolResultContent(part.content, "ollama", part.toolUseId),
          tool_name: part.toolUseId,
        });
      }
    }
    const userText = joinTextParts(message);
    if (userText.length > 0) out.push({ role: "user", content: userText });
    return out;
  }
  // assistant
  const text = joinTextParts(message);
  const toolCalls: OllamaToolCall[] = [];
  for (const part of message.content) {
    if (part.type === "tool_use") {
      toolCalls.push({
        function: { name: part.name, arguments: part.input },
      });
    }
  }
  const msg: OllamaChatMessage = { role: "assistant", content: text };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return [msg];
}

function joinTextParts(message: LlmMessage): string {
  return message.content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
}

function toOllamaTools(tools: LlmRequest["tools"]): OllamaTool[] {
  if (tools === undefined || tools.length === 0) return [];
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}
