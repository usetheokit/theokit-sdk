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
 * Options accepted by {@link Agent.generateObject}. Returns a typed object
 * matching the supplied Zod schema. See ADR D33.
 *
 * @public
 */
export interface GenerateObjectOptions<T extends ZodType> {
  /** Zod schema describing the expected object shape. */
  schema: T;
  /** User prompt — the model is asked to fill the schema given this prompt. */
  prompt: string;
  /** Optional system prompt steering the model. */
  systemPrompt?: string;
  /** Model selection. Required (transient agents need a model). SE8 — accepts a
   *  bare-string id shorthand (`"openai/gpt-4o-mini"`) or a {@link ModelSelection}. */
  model: string | ModelSelection;
  /**
   * M21 — optional separate model for the STRUCTURING step. When set, `model` first produces a
   * free-text reasoned answer to the prompt (phase 1), then `structuringModel` extracts the
   * schema-matched object by calling the `output` tool over that answer (phase 2). Lets a large
   * model reason while a cheap fast model does the extraction. Absent ⇒ today's single-model flow.
   */
  structuringModel?: string | ModelSelection;
  /** API key. Falls back to env (THEOKIT_API_KEY etc). */
  apiKey?: string;
  /** Local runtime config (cwd, sandbox). Required to keep the transient agent local-only. */
  local: LocalOptions;
  /**
   * Retry budget on parse failures. Default 1 (initial attempt + 1 retry).
   * The transient agent is REUSED across retries so the registry sees a
   * single entry (EC-3).
   */
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
   * What to do when the model's output fails schema validation after all
   * retries are exhausted (M14):
   * - `'throw'` (default) — throw {@link GenerateObjectError} `parse_failed`.
   * - `'return-raw'` — resolve with the raw, UNVALIDATED input the model sent
   *   (`object` may not match the schema; inspect `raw` too).
   * - `'return-partial'` — for object schemas, resolve with only the fields that
   *   individually validate (best-effort salvage); non-object schemas fall back
   *   to raw.
   */
  errorStrategy?: "throw" | "return-partial" | "return-raw";
  /**
   * Builtin tools removed from every transient agent's catalogue (the reasoning-phase agent of
   * `structuringModel` included), forwarded to {@link AgentOptions.withheldBuiltinTools}.
   * Absent ⇒ unchanged default: the agent holds `shell`. Pass `["shell"]` for a step that must
   * only produce JSON. The `output` tool is never withheld.
   */
  withheldBuiltinTools?: readonly BuiltinToolName[];
  /**
   * Memory settings for every transient agent of the call, forwarded to {@link AgentOptions.memory}.
   * Absent ⇒ unchanged default (a session transcript is written). Pass `{ enabled: false }`
   * for a step that must leave no transcript.
   */
  memory?: MemorySettings;
}

/**
 * Successful return from {@link Agent.generateObject}.
 *
 * @public
 */
export interface GenerateObjectResult<T> {
  /** Typed object parsed via the Zod schema. */
  object: T;
  /** Raw input the model passed to the synthetic tool, before Zod parse. */
  raw: unknown;
  /** Token usage of the LLM call(s) that produced the result. */
  usage: { inputTokens: number; outputTokens: number };
  /** Stop reason of the underlying agent run. */
  finishReason: "tool_use" | "error";
}

/**
 * Typed error thrown by {@link Agent.generateObject} when the model refuses
 * to call the synthetic `output` tool or when retries are exhausted.
 *
 * @public
 */
export class GenerateObjectError extends StructuredOutputError {
  override readonly name = "GenerateObjectError";
}

interface GenerateObjectDeps {
  create: (options: AgentOptions) => Promise<SDKAgent>;
  /** Hard-delete the transient agent from the registry after dispose. */
  delete: (agentId: string) => Promise<void>;
}

/**
 * M14 — best-effort partial salvage for `errorStrategy: 'return-partial'`. For an object schema,
 * keep only the fields that individually validate; anything else (non-object schema or non-object
 * raw) falls back to the raw value. Works across Zod v3/v4 via the `.shape` record both expose.
 */
function salvagePartial<T extends ZodType>(schema: T, raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const shape = (schema as { shape?: Record<string, ZodType> }).shape;
  if (shape === undefined || typeof shape !== "object") return raw;
  const rawObj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (typeof fieldSchema?.safeParse !== "function") continue;
    const parsed = fieldSchema.safeParse(rawObj[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/**
 * M21 — phase 1: run `options.model` as a plain reasoning agent (no output tool) and return its
 * free-text answer, which phase 2's structuring model then extracts. The transient reasoning agent
 * is disposed + hard-deleted so the registry count stays stable (EC-3, mirrors the phase-2 finally).
 */
async function runReasoningPhase<T extends ZodType>(
  options: GenerateObjectOptions<T>,
  deps: GenerateObjectDeps,
): Promise<string> {
  const reasoningOptions: AgentOptions = {
    model: options.model,
    local: options.local,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.providers !== undefined ? { providers: options.providers } : {}),
    ...(options.withheldBuiltinTools !== undefined
      ? { withheldBuiltinTools: options.withheldBuiltinTools }
      : {}),
    ...(options.memory !== undefined ? { memory: options.memory } : {}),
  };
  const reasoningAgent = await deps.create(reasoningOptions);
  try {
    const run = await reasoningAgent.send(options.prompt);
    const result = await run.wait();
    const text = (result as { result?: unknown }).result;
    return typeof text === "string" ? text : options.prompt;
  } finally {
    await disposeAndDeleteTransient(reasoningAgent, deps.delete);
  }
}

/**
 * Implementation of `Agent.generateObject`. Receives the `Agent.create`
 * factory as a callback to keep the dependency graph acyclic (mirrors the
 * AgentBuilder pattern in D25 / agent.ts injection).
 *
 * Algorithm:
 *   1. Convert the consumer's Zod schema to JSON Schema.
 *   2. Build a single synthetic `output` CustomTool whose handler captures
 *      the raw input and short-circuits the agent loop. The handler
 *      THROWS a sentinel so the loop terminates immediately without a
 *      second LLM round-trip.
 *   3. Create ONE transient agent (per the entire generateObject call,
 *      not per retry — EC-3). Each retry re-sends through the same agent,
 *      driving fresh LLM rounds.
 *   4. On each attempt, send a wrapper prompt instructing the model to
 *      call the `output` tool. Capture the raw input via the sentinel.
 *   5. Parse the raw input via schema.parse. On success, return typed.
 *      On failure, retry until the budget is exhausted.
 *   6. Always dispose the transient agent in `finally`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retry loop + capture sentinel + dispose-and-delete is a single transaction; splitting harms locality and the finally block.
export async function generateObjectImpl<T extends ZodType>(
  options: GenerateObjectOptions<T>,
  deps: GenerateObjectDeps,
): Promise<GenerateObjectResult<ZodNamespace.infer<T>>> {
  const { jsonSchema, maxRetries, initialUsage } = setupStructuredOutput(
    options.schema,
    options.maxRetries,
  );
  let capturedRaw: unknown;
  let lastUsage = initialUsage;
  const sentinel = Symbol("generate-object-sentinel");
  class CaptureSentinel extends Error {
    readonly [sentinel] = true;
    constructor(public readonly captured: unknown) {
      super("generate-object-capture");
    }
  }

  const outputTool = makeOutputTool(jsonSchema, (input) => {
    // EC-D10 (parallel tool use): first capture wins. Subsequent calls
    // in the same response are ignored.
    if (capturedRaw === undefined) {
      capturedRaw = input;
    }
    throw new CaptureSentinel(input);
  });

  // M21 — when a separate structuring model is set, `model` first reasons in free text (phase 1),
  // and `structuringModel` extracts the object over that text (phase 2). Absent ⇒ single-model flow.
  const reasoningText =
    options.structuringModel !== undefined ? await runReasoningPhase(options, deps) : undefined;
  const structuringModel = options.structuringModel ?? options.model;
  const structuringPrompt = reasoningText ?? options.prompt;

  const agentOptions: AgentOptions = buildTransientAgentOptions({
    model: structuringModel,
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

  try {
    const userMessage = buildToolPrompt(structuringPrompt);
    let lastParseError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      capturedRaw = undefined;
      const run = await agent.send(userMessage);
      const result = await run.wait();
      lastUsage = extractUsage(result);

      if (capturedRaw === undefined) {
        // EC: when the underlying run errored (e.g. provider_unresolved),
        // surface the original cause instead of the misleading "model
        // returned text" message — there was no model call at all.
        if (result.status === "error" && result.error !== undefined) {
          throw new GenerateObjectError(
            "no_tool_call",
            STRUCTURED_OUTPUT_MESSAGES.runFailed(result.error.message, result.error.code),
            result.error,
          );
        }
        // Model didn't call the output tool.
        if (attempt === maxRetries) {
          throw new GenerateObjectError("no_tool_call", STRUCTURED_OUTPUT_MESSAGES.noToolCall);
        }
        continue;
      }

      const parsed = options.schema.safeParse(capturedRaw);
      if (parsed.success) {
        return {
          object: parsed.data,
          raw: capturedRaw,
          usage: lastUsage,
          finishReason: "tool_use",
        };
      }
      lastParseError = parsed.error;
    }

    // M14 — all retries exhausted with a parse failure. `errorStrategy` decides the outcome; the
    // tool WAS called (capturedRaw is set), so `finishReason` stays `tool_use`.
    if (options.errorStrategy === "return-raw") {
      return {
        object: capturedRaw as ZodNamespace.infer<T>,
        raw: capturedRaw,
        usage: lastUsage,
        finishReason: "tool_use",
      };
    }
    if (options.errorStrategy === "return-partial") {
      return {
        object: salvagePartial(options.schema, capturedRaw) as ZodNamespace.infer<T>,
        raw: capturedRaw,
        usage: lastUsage,
        finishReason: "tool_use",
      };
    }
    throw new GenerateObjectError(
      "parse_failed",
      STRUCTURED_OUTPUT_MESSAGES.parseFailed,
      lastParseError,
    );
  } finally {
    // EC-3: dispose AND hard-delete the transient agent so registry count
    // stays stable across retries.
    await disposeAndDeleteTransient(agent, deps.delete);
  }
}
