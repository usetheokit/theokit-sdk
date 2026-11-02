import type { z as ZodNamespace, ZodType } from "zod";
import { StructuredOutputError } from "./errors.js";
import {
  buildToolPrompt,
  buildTransientAgentOptions,
  disposeAndDeleteTransient,
  extractUsage,
  makeOutputTool,
  STRUCTURED_OUTPUT_MESSAGES,
  setupStructuredOutput,
} from "./internal/structured-output-helpers.js";
import type {
  AgentOptions,
  BuiltinToolName,
  LocalOptions,
  MemorySettings,
  ModelSelection,
  SDKAgent,
} from "./types/agent.js";
import type { ProviderRoutingSettings } from "./types/providers.js";

/**
 * Options accepted by {@link Agent.streamObject}. Same shape as
 * `Agent.generateObject` with the addition that the result is an
 * `AsyncIterator<StreamObjectEvent<T>>` rather than a single Promise. See ADR D39.
 *
 * @public
 */
export interface StreamObjectOptions<T extends ZodType> {
  schema: T;
  prompt: string;
  systemPrompt?: string;
  /** SE8 — accepts a bare-string id shorthand or a {@link ModelSelection}. */
  model: string | ModelSelection;
  apiKey?: string;
  local: LocalOptions;
  maxRetries?: number;
  /**
   * Optional provider routing forwarded to the transient agent. Required when
   * `model.id` uses a prefix (e.g. `openai/gpt-4o-mini`) but the credential is
   * for a unified gateway (e.g. OpenRouter). Without this, the SDK infers
   * provider from the prefix and may fail with `provider_unresolved` even
   * when the right env key is set under a different provider name.
   */
  providers?: ProviderRoutingSettings;
  /**
   * Builtin tools removed from the transient agent's catalogue, forwarded to
   * {@link AgentOptions.withheldBuiltinTools}. Absent ⇒ unchanged default: the agent holds
   * `shell`. Pass `["shell"]` for a step that must only produce JSON. The `output` tool is
   * never withheld.
   */
  withheldBuiltinTools?: readonly BuiltinToolName[];
  /**
   * Memory settings for the transient agent, forwarded to {@link AgentOptions.memory}.
   * Absent ⇒ unchanged default (a session transcript is written). Pass `{ enabled: false }`
   * for a step that must leave no transcript.
   */
  memory?: MemorySettings;
}

/**
 * Recursive partial — `T` where every nested field becomes optional.
 *
 * @public
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Event emitted by {@link Agent.streamObject}. Discriminate on `type`.
 *
 * - `partial` events fire zero or more times with monotonically increasing
 *   `attempt`, carrying best-effort schema-parsed snapshots of the model's
 *   accumulating output.
 * - `complete` fires exactly once at the end, carrying the fully Zod-parsed
 *   object alongside usage and finishReason — semantically identical to a
 *   successful `Agent.generateObject()` return.
 *
 * @public
 */
export type StreamObjectEvent<T> =
  | { type: "partial"; partial: DeepPartial<T>; attempt: number }
  | {
      type: "complete";
      object: T;
      raw: unknown;
      usage: { inputTokens: number; outputTokens: number };
      finishReason: "tool_use" | "error";
    };

/**
 * Error thrown by {@link Agent.streamObject} when the model refuses to call
 * the synthetic `output` tool or when all retries fail to produce a
 * schema-valid object. Same code taxonomy as `GenerateObjectError`.
 *
 * @public
 */
export class StreamObjectError extends StructuredOutputError {
  override readonly name = "StreamObjectError";
}

interface StreamObjectDeps {
  create: (options: AgentOptions) => Promise<SDKAgent>;
  delete: (agentId: string) => Promise<void>;
}

/**
 * Implementation of `Agent.streamObject` as an async generator. Mirrors the
 * synthetic-forced-tool pattern from `generate-object.ts` (ADR D33) with the
 * addition of intermediate `partial` events emitted from incremental parsing
 * of accumulating text deltas during the agent loop.
 *
 * REACHED BY DYNAMIC IMPORT — do not delete on a dead-code report (B-140).
 * `agent.ts` loads this module lazily to keep it off the eager path:
 *
 *     streamObjectImport ??= import("./stream-object.js");
 *     const { streamObjectImpl } = await streamObjectImport;
 *
 * `knip` resolves imports statically and does not follow a destructure off a
 * dynamic-import promise, so it reports this export as unused on every run. It
 * is not: removing it breaks `Agent.streamObject`. The `@knipignore` tag below
 * silences that one false positive — a tool limitation, not a suppression of a
 * real finding, and the difference is the whole reason this comment exists.
 *
 * The tag replaced a whole-file entry in `knip.json`'s ignore list, which also
 * excluded the four other exports in this file from dead-code analysis. The tag
 * is scoped to the symbol knip actually cannot resolve, so the rest of the file
 * is examined again.
 *
 * @knipignore reached only via `await import()` in agent.ts; knip cannot follow it
 * @internal
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: streaming loop interleaves text-delta accumulation, partial-parse attempts, retries, and final dispose — splitting harms locality of the iterator contract.
export async function* streamObjectImpl<T extends ZodType>(
  options: StreamObjectOptions<T>,
  deps: StreamObjectDeps,
): AsyncGenerator<StreamObjectEvent<ZodNamespace.infer<T>>, void, void> {
  const { jsonSchema, maxRetries, initialUsage } = setupStructuredOutput(
    options.schema,
    options.maxRetries,
  );
  let capturedRaw: unknown;
  let lastUsage = initialUsage;

  const outputTool = makeOutputTool(jsonSchema, (input) => {
    // EC-6: first capture wins (parallel tool use in Claude 3.5+).
    if (capturedRaw === undefined) {
      capturedRaw = input;
    }
    return JSON.stringify({ ok: true });
  });

  const agentOptions: AgentOptions = buildTransientAgentOptions({
    model: options.model,
    local: options.local,
    outputTool,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.providers !== undefined ? { providers: options.providers } : {}),
    ...(options.withheldBuiltinTools !== undefined
      ? { withheldBuiltinTools: options.withheldBuiltinTools }
      : {}),
    ...(options.memory !== undefined ? { memory: options.memory } : {}),
  });
  const agent = await deps.create(agentOptions);
  const userMessage = buildToolPrompt(options.prompt);

  try {
    let lastParseError: unknown;
    let attemptCounter = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      capturedRaw = undefined;
      const run = await agent.send(userMessage);

      // Buffer text deltas during streaming; try partial-parse on each.
      let textBuffer = "";
      for await (const msg of run.stream()) {
        if (msg.type === "assistant") {
          const newText = msg.message.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
          if (newText.length > 0) {
            textBuffer += newText;
            const partial = bestEffortPartialParse(textBuffer, options.schema);
            if (partial !== undefined) {
              attemptCounter += 1;
              yield {
                type: "partial",
                partial: partial as DeepPartial<ZodNamespace.infer<T>>,
                attempt: attemptCounter,
              };
            }
          }
        }
      }
      const result = await run.wait();
      lastUsage = extractUsage(result);

      if (capturedRaw === undefined) {
        // EC: when the underlying run errored (e.g. provider_unresolved),
        // surface the original cause instead of the misleading "model
        // returned text" message — there was no model call at all.
        if (result.status === "error" && result.error !== undefined) {
          throw new StreamObjectError(
            "no_tool_call",
            STRUCTURED_OUTPUT_MESSAGES.runFailed(result.error.message, result.error.code),
            result.error,
          );
        }
        if (attempt === maxRetries) {
          throw new StreamObjectError("no_tool_call", STRUCTURED_OUTPUT_MESSAGES.noToolCall);
        }
        continue;
      }

      const parsed = options.schema.safeParse(capturedRaw);
      if (parsed.success) {
        yield {
          type: "complete",
          object: parsed.data,
          raw: capturedRaw,
          usage: lastUsage,
          finishReason: "tool_use",
        };
        return;
      }
      lastParseError = parsed.error;
    }

    throw new StreamObjectError(
      "parse_failed",
      STRUCTURED_OUTPUT_MESSAGES.parseFailed,
      lastParseError,
    );
  } finally {
    // EC-4: even if consumer calls iter.return() mid-stream, this finally
    // runs — transient agent is disposed AND removed from registry.
    await disposeAndDeleteTransient(agent, deps.delete);
  }
}

/**
 * Try to extract a partial JSON object from a possibly-incomplete text
 * buffer and parse it via the schema in lenient mode. Returns `undefined`
 * if nothing parseable is found yet.
 *
 * Strategy: find the first `{`, find the LAST balanced `}` (greedy), parse
 * the substring as JSON, then `safeParse` against `schema.partial()` if the
 * schema supports it, else against the original schema.
 *
 * @internal
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stateful JSON-balancing scanner — string/brace/escape state must be co-located for the parser to remain correct.
function bestEffortPartialParse<T extends ZodType>(text: string, schema: T): unknown | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  // Find the longest balanced JSON object from `start`.
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      isEscaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) end = i;
    }
  }
  if (end < 0) return undefined;
  const candidate = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  // Try schema.partial() if available (Zod objects support it); else fall
  // back to the original schema (loose match).
  const maybePartial = (schema as unknown as { partial?: () => ZodType }).partial;
  const looseSchema = typeof maybePartial === "function" ? maybePartial.call(schema) : schema;
  const result = looseSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
