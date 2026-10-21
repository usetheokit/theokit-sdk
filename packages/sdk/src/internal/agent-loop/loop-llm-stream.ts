import { diag } from "../diagnostics.js";
import { isAnthropicFamilyModel } from "../llm/model-capabilities.js";
import { derivePromptCacheKey } from "../llm/prompt-cache-key.js";
import type {
  LlmClient,
  LlmSystemBlock,
  LlmThinkingPart,
  LlmTool,
  LlmToolCallPart,
} from "../llm/types.js";
import { escapeBlockBody } from "../runtime/system-prompt/escape.js";
import { safeCall } from "../runtime/system-prompt/safe-call.js";
import { HISTOGRAM_NAMES } from "../telemetry/span-names.js";
import { stripThinkBlocks } from "../tool-dispatch/strip-think.js";
import type { LoopContext } from "./loop-context-init.js";
import { buildAssistantEvent, buildThinkingEvent } from "./message-builders.js";
import type { ResolvedTool } from "./tool-dispatch.js";
import type { AgentLoopInputs } from "./types.js";

/** @internal */
export interface LlmTurnOutput {
  text: string;
  toolCalls: LlmToolCallPart[];
  stopReason: string;
  errored: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /**
   * theokit#122 — the round's extended-thinking block.
   *
   * A per-ROUND value, deliberately. The first cut of this fix parked it on `LoopContext` as
   * `pendingThinking` and consumed it only where the assistant TEXT step was emitted — which is
   * skipped when a round produces thinking + a tool call and no preamble text (the common Anthropic
   * shape). The block then survived into the next round and was persisted against the WRONG text,
   * invalidating the signature it exists to preserve. Carrying it on the round's own output makes
   * that class of leak unrepresentable.
   */
  thinking?: LlmThinkingPart;
}

/**
 * Fold a `MemoryProvider`'s `systemPromptAdditions` into the inbound `inputs.systemPrompt`, as the
 * same `<active-memory>` block the assembly pipeline produces.
 *
 * IT USED TO CONCATENATE THE RAW STRING, and that was a regression waiting for the day the port path
 * became the default. Recalled memory is UNTRUSTED content — it is whatever went into the index —
 * and `ActiveMemoryPromptProvider` runs it through {@link escapeBlockBody} for that reason (ADR D9,
 * prompt-injection defence): without the escape, a recalled fact containing `</active-memory>`
 * closes the block and everything after it reads as system instruction.
 *
 * Measured 2026-09-02 by running the memory suites with `THEOKIT_PORT_MEMORY_PATH=1`: the port path
 * dropped the delimiters AND the escape, and the golden test asserting the block caught the first
 * half. The second half nothing would have caught.
 *
 * PREPENDED, not appended, because the legacy provider declares `priority = 5` — ahead of Context,
 * Skills and Memory — so the recall summary sits at the top of the prompt. The value the loop
 * receives is the fully assembled prompt, so prepending is what reproduces that position. An
 * Anthropic-family model puts the block after the prompt instead, see {@link buildLoopSystem}.
 *
 * @internal
 */
export function resolveSystemPromptWithMemoryAdditions(
  systemPrompt: string | undefined,
  additions: string | undefined,
): string | undefined {
  if (additions === undefined || additions.length === 0) return systemPrompt;
  const block = activeMemoryBlock(additions);
  if (systemPrompt === undefined || systemPrompt.length === 0) return block;
  return `${block}\n\n${systemPrompt}`;
}

function activeMemoryBlock(additions: string): string {
  return `<active-memory>\n${escapeBlockBody(additions)}\n</active-memory>`;
}

/**
 * B-412 — for an Anthropic-family model the configured prompt is block 1, cacheable, and the
 * `<active-memory>` block follows it, so changing memory never sits in front of the cached
 * prefix. Any other model, or an empty prompt, gets {@link resolveSystemPromptWithMemoryAdditions}.
 * @internal
 */
export function buildLoopSystem(
  systemPrompt?: string,
  additions?: string,
  modelId?: string,
): string | LlmSystemBlock[] | undefined {
  if (!isAnthropicFamilyModel(modelId) || systemPrompt === undefined || systemPrompt.length === 0) {
    return resolveSystemPromptWithMemoryAdditions(systemPrompt, additions);
  }
  const blocks: LlmSystemBlock[] = [{ text: systemPrompt, cacheable: true }];
  if (additions !== undefined && additions.length > 0) {
    blocks.push({ text: activeMemoryBlock(additions) });
  }
  return blocks;
}

function toLlmTool(tool: ResolvedTool): LlmTool {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/**
 * issue #47: extract the reasoning effort from `ModelSelection.params` — the canonical `thinking`
 * param (`{ id: "thinking", value: "high" }`) the agents bridge sets from `reasoningEffort`. Returns
 * undefined when absent so the provider request stays bare (no reasoning requested).
 * @internal
 */
export function reasoningEffortFromParams(
  params: AgentLoopInputs["model"]["params"],
): string | undefined {
  const thinking = params?.find((p) => p.id === "thinking");
  return thinking !== undefined && thinking.value.length > 0 ? thinking.value : undefined;
}

/**
 * M3 #64/#66 — emit the LLM-call duration + token throughput as metrics (were
 * span-attributes only); a provider that omits usage WARNs + counts
 * `llm_usage_missing` so budget undercount is observable instead of a silent 0.
 * @internal
 */
function emitLlmMetrics(
  inputs: AgentLoopInputs,
  result: { inputTokens?: number; outputTokens?: number },
  startAt: number,
): void {
  inputs.telemetry?.recordHistogram(HISTOGRAM_NAMES.LLM_CALL_DURATION_MS, Date.now() - startAt, {
    provider: inputs.llm.name,
  });
  if (result.inputTokens === undefined && result.outputTokens === undefined) {
    inputs.telemetry?.recordHistogram(HISTOGRAM_NAMES.LLM_USAGE_MISSING, 1, {
      provider: inputs.llm.name,
    });
    diag(
      `[theokit-sdk] llm usage missing from ${inputs.llm.name} finish — budget may undercount\n`,
    );
    return;
  }
  inputs.telemetry?.recordHistogram(
    HISTOGRAM_NAMES.LLM_TOKENS,
    (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
    { provider: inputs.llm.name },
  );
}

/** @internal */
export async function streamLlmTurn(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
): Promise<LlmTurnOutput> {
  // M3 #64 — nest llm.call under the run's agent.send span (not a flat sibling).
  const llmSpan = inputs.telemetry?.startChildSpan(ctx.sendSpan, "llm.call", {
    "model.id": inputs.model.id ?? "auto",
    provider: inputs.llm.name,
  });
  const startAt = Date.now();
  const signal = inputs.signal ?? new AbortController().signal;
  const generator = inputs.llm.stream(
    {
      model: inputs.model.id ?? "auto",
      ...((): { system?: string | LlmSystemBlock[] } => {
        const effective = buildLoopSystem(
          inputs.systemPrompt,
          ctx.memorySystemPromptAdditions,
          inputs.model.id,
        );
        return effective !== undefined ? { system: effective } : {};
      })(),
      // issue #47: forward the reasoning effort from ModelSelection.params (the `thinking` param)
      // so the provider produces reasoning. Absent param ⇒ no `reasoning` field (bare request).
      ...((): { reasoning?: { effort: string } } => {
        const effort = reasoningEffortFromParams(inputs.model.params);
        return effort !== undefined ? { reasoning: { effort } } : {};
      })(),
      // Step-cap force-close: forward the per-run tool gate (`"none"` on a ceiling round forces a
      // text close even though tools are advertised). Absent ⇒ provider default (auto).
      ...(inputs.toolChoice !== undefined ? { toolChoice: inputs.toolChoice } : {}),
      // usetheokit/theokit-sdk#383 — the prompt-cache key, derived HERE and from `inputs.agentId`
      // because this is the one place that sees the session identity on every round. `agentId` is
      // the run's session identity (`Agent.getOrCreate(sessionId)`), so the derived key is identical
      // on round 1 and round 12 of a turn, identical on turn 2 of the same session, and different
      // for a different session. Deriving it per round from a stable input is what makes it a cache
      // key; minting one anywhere that runs more than once per session would not be.
      ...((): { promptCacheKey?: string } => {
        const key = derivePromptCacheKey(inputs.agentId);
        return key !== undefined ? { promptCacheKey: key } : {};
      })(),
      messages: ctx.messages,
      tools: ctx.tools.map(toLlmTool),
    },
    signal,
  );
  const collected = await collectLlmEvents(generator, inputs, ctx);
  if (collected.errored || collected.finishValue === undefined) {
    llmSpan?.setAttribute("stopReason", "error");
    llmSpan?.end();
    return {
      text: collected.accumulatedText,
      toolCalls: [],
      stopReason: "error",
      errored: true,
    };
  }
  const result = collected.finishValue.value as Awaited<
    ReturnType<LlmClient["stream"]>
  > extends AsyncGenerator<unknown, infer R, unknown>
    ? R
    : never;
  llmSpan?.setAttributes({
    stopReason: result.stopReason,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
  });
  emitLlmMetrics(inputs, result, startAt);
  llmSpan?.end();
  const stripped = stripThinkBlocks(collected.accumulatedText);
  // theokit#122 — the provider's own block wins. Anthropic reports it on the finish value WITH the
  // signature; `collected.thinking` is the reconstruction from `reasoning_delta`s, which is all an
  // OpenAI-compatible provider can offer (it never signs). Preferring the finish value is also what
  // stops `LlmFinish.thinking` from being the declared-but-unread channel theokit#144 deleted.
  const thinking = result.thinking ?? collected.thinking;
  return {
    text: stripped.visible,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    errored: false,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    reasoningTokens: result.reasoningTokens,
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

interface CollectedEvents {
  accumulatedText: string;
  errored: boolean;
  /** theokit#122 — the block rebuilt from `reasoning_delta`s, for providers that do not report one. */
  thinking?: LlmThinkingPart;
  finishValue: Awaited<ReturnType<ReturnType<LlmClient["stream"]>["next"]>> | undefined;
}

async function collectLlmEvents(
  generator: ReturnType<LlmClient["stream"]>,
  inputs: AgentLoopInputs,
  ctx: LoopContext,
): Promise<CollectedEvents> {
  let errored = false;
  let finishValue: CollectedEvents["finishValue"];
  let thinking: LlmThinkingPart | undefined;
  // #371 — the text lives OUTSIDE the try, because a mid-stream throw leaves with the exception and
  // takes any local with it. A cut stream used to reach the catch below with nothing to report, so
  // a 1490-character answer severed before its terminator reached the caller as "". Truncated
  // streams are routine — proxy timeouts, load-balancer idle limits, mobile links — and the longer
  // the answer, the more each one destroyed.
  const partial = { text: "" };
  try {
    const result = await runCollectorLoop(generator, inputs, ctx, partial);
    errored = result.errored;
    finishValue = result.finishValue;
    thinking = result.thinking;
  } catch (cause) {
    if (inputs.signal?.aborted === true) {
      // A caller's own abort has its own marker, and preserving partial text must not overwrite it:
      // the caller already knows what it asked for.
      ctx.finalText = "[aborted]";
      ctx.events.push(buildAssistantEvent(inputs, "[aborted]"));
    } else {
      registerLoopError(ctx, cause);
      // The turn is still errored — this hands back what arrived, it does not call it a success.
      ctx.finalText = partial.text;
      if (partial.text !== "") ctx.events.push(buildAssistantEvent(inputs, partial.text));
    }
    errored = true;
  }
  const accumulatedText = partial.text;
  return {
    accumulatedText,
    errored,
    finishValue,
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

/**
 * Set-once invariant (ADR D3, EC-3-A): first error wins.
 * @internal
 */
export function registerLoopError(ctx: LoopContext, cause: unknown): void {
  if (ctx.error !== undefined) return;
  const rawMessage = (cause as { message?: unknown } | null | undefined)?.message;
  const message =
    typeof rawMessage === "string"
      ? rawMessage
      : cause instanceof Error
        ? cause.message
        : String(cause);
  // Prefer the CANONICAL `metadata.code` (e.g. "context_too_long") over the
  // provider-PREFIXED top-level `.code` (e.g. "anthropic_context_too_long") that
  // the error mappers set for telemetry — so the run boundary (`RunResult.error.code`)
  // reports the canonical `ErrorCode` and consumer checks like
  // `result.error.code === "context_too_long"` work for every provider.
  const metaCode = (cause as { metadata?: { code?: unknown } } | null | undefined)?.metadata?.code;
  const rawCode = (cause as { code?: unknown } | null | undefined)?.code;
  const code =
    typeof metaCode === "string" ? metaCode : typeof rawCode === "string" ? rawCode : undefined;
  ctx.error = code !== undefined ? { message, code, cause } : { message, cause };
}

/**
 * Take one non-terminal stream event; returns the text it contributed (empty for reasoning).
 *
 * Extracted so `runCollectorLoop` stays under the cognitive-complexity cap once theokit#122 added
 * the reasoning branch's signature handling.
 */
async function consumeStreamEvent(
  inputs: AgentLoopInputs,
  reasoning: ReasoningAccumulator,
  event: { type: string; text?: string; signature?: string },
): Promise<string> {
  if (event.type === "text_delta") {
    const text = event.text ?? "";
    // B-497: the first answer text ends the reasoning block, so close it before the text shows.
    if (text.length > 0) await closeReasoningOnce(inputs, reasoning);
    await emitTextDeltaCallback(inputs, text);
    return text;
  }
  if (event.type === "reasoning_delta") {
    await consumeReasoningDelta(inputs, reasoning, {
      text: event.text ?? "",
      ...(event.signature !== undefined ? { signature: event.signature } : {}),
    });
  }
  return "";
}

async function runCollectorLoop(
  generator: ReturnType<LlmClient["stream"]>,
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  /**
   * #371 — the caller's holder for the text collected SO FAR. Written on every delta so that a
   * mid-stream throw, which never reaches this function's `return`, still leaves the caller with
   * what arrived.
   */
  partial: { text: string },
): Promise<{
  errored: boolean;
  finishValue: CollectedEvents["finishValue"];
  thinking?: LlmThinkingPart;
}> {
  // issue #47/#48: reasoning streams on its own channel — `text` is accumulated for the
  // `thinking` SDKMessage replay; the duration is `lastAt - startedAt` (B-497).
  const reasoning: ReasoningAccumulator = {
    text: "",
    startedAt: undefined,
    lastAt: undefined,
    signature: undefined,
    closed: false,
    durationMs: 0,
  };
  let errored = false;
  let finishValue: CollectedEvents["finishValue"];
  let thinking: LlmThinkingPart | undefined;
  // issue #48 (review Finding 1): finalize in a `finally` so a mid-stream THROW from the LLM
  // generator (e.g. a dropped connection after some reasoning deltas) still emits the one
  // `thinking-completed` — otherwise a consumer that opened a reasoning block on the first
  // `thinking-delta` would wait for a close signal that never comes. The in-band `error` event
  // path (break below) already reaches finalize; this covers the hard-throw path too.
  try {
    while (true) {
      const next = await generator.next();
      if (next.done === true) {
        finishValue = next;
        break;
      }
      if (next.value.type === "error") {
        registerLoopError(ctx, next.value);
        // #371 — same reasoning as the throw path: an in-band provider error does not make the
        // tokens that preceded it disappear.
        ctx.finalText = partial.text;
        errored = true;
        break;
      }
      partial.text += await consumeStreamEvent(inputs, reasoning, next.value);
    }
  } finally {
    thinking = await finalizeReasoning(inputs, ctx, reasoning);
  }
  return { errored, finishValue, ...(thinking !== undefined ? { thinking } : {}) };
}

/**
 * theokit#122 — take one reasoning delta, text and signature alike.
 *
 * The signature rides its OWN text-less delta (Anthropic emits `signature_delta` after the thinking
 * text), so it is captured before the text is accumulated — otherwise a signature-only delta would
 * be indistinguishable from an empty reasoning chunk and thrown away.
 */
async function consumeReasoningDelta(
  inputs: AgentLoopInputs,
  reasoning: ReasoningAccumulator,
  delta: { text: string; signature?: string },
): Promise<void> {
  if (delta.signature !== undefined) reasoning.signature = delta.signature;
  await accumulateReasoning(inputs, reasoning, delta.text);
}

/** issue #47/#48: reasoning accumulated across a single LLM turn. */
interface ReasoningAccumulator {
  text: string;
  startedAt: number | undefined;
  /**
   * theokit#122 — the provider's cryptographic signature for this thinking block. Anthropic sends
   * it once, on its own delta, after the text. Kept as last-seen-wins: one block, one signature.
   */
  signature: string | undefined;
  /**
   * B-497: when the last reasoning delta before the close arrived. The duration is
   * `lastAt - startedAt`: the reasoning span, never the time the answer or a tool call took after it.
   * A text-less delta counts too, so Anthropic's signature delta, which ends its thinking block, is
   * inside the span. A block that arrives in a single delta reports 0.
   */
  lastAt: number | undefined;
  /** B-497: set once `thinking-completed` was sent, so a turn closes its reasoning exactly once. */
  closed: boolean;
  /** B-497: the duration the close reported, reused for the replayed `thinking` SDKMessage. */
  durationMs: number;
}

/**
 * issue #47/#48: accumulate one reasoning delta — stamp the block start on the first delta
 * (for the duration measurement) and surface it live as a `thinking-delta`.
 */
async function accumulateReasoning(
  inputs: AgentLoopInputs,
  reasoning: ReasoningAccumulator,
  text: string,
): Promise<void> {
  const now = Date.now();
  if (reasoning.startedAt === undefined) reasoning.startedAt = now;
  // B-497: a delta after the close is still shown and replayed, but the span was already reported.
  if (!reasoning.closed) reasoning.lastAt = now;
  reasoning.text += text;
  await emitReasoningDeltaCallback(inputs, text);
}

/**
 * B-497: close the reasoning block once, on the first answer text, or at the end of the stream when
 * no text follows (a tool-only turn, an error, a throw). The duration is the reasoning span, so it is
 * the same whichever of the two moments sends it. No-op without reasoning or after the first close.
 */
async function closeReasoningOnce(
  inputs: AgentLoopInputs,
  reasoning: ReasoningAccumulator,
): Promise<void> {
  if (reasoning.closed || reasoning.text.length === 0) return;
  reasoning.closed = true;
  // Non-empty text means `accumulateReasoning` ran, and it sets both stamps before appending, so the
  // fallbacks only satisfy the type.
  reasoning.durationMs = (reasoning.lastAt ?? 0) - (reasoning.startedAt ?? 0);
  await emitThinkingCompletedCallback(inputs, reasoning.durationMs);
}

/**
 * issue #47/#48: finalize the reasoning block for this turn. Emit the accumulated reasoning as a
 * `thinking` SDKMessage (run.stream replay) BEFORE the assistant turn — preserving reason-then-answer
 * order, carrying the reasoning span, and close the live channel if the first answer text has not
 * already closed it (B-497). No-op when the model produced no reasoning.
 */
async function finalizeReasoning(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  reasoning: ReasoningAccumulator,
): Promise<LlmThinkingPart | undefined> {
  if (reasoning.text.length === 0) return undefined;
  await closeReasoningOnce(inputs, reasoning);
  ctx.events.push(
    buildThinkingEvent(inputs, reasoning.text, reasoning.durationMs, reasoning.signature),
  );
  // theokit#122 — RETURNED, not stashed on the context. See `LlmTurnOutput.thinking` for why the
  // context-state version leaked a signature onto the following round's text.
  return {
    type: "thinking",
    text: reasoning.text,
    ...(reasoning.signature !== undefined ? { signature: reasoning.signature } : {}),
  };
}

async function emitTextDeltaCallback(inputs: AgentLoopInputs, text: string): Promise<void> {
  if (inputs.onDelta === undefined) return;
  const cb = inputs.onDelta;
  await safeCall(
    () => cb({ update: { type: "text-delta", text } }),
    undefined,
    "SendOptions.onDelta",
  );
}

/** issue #47: deliver a reasoning delta live as a `thinking-delta` InteractionUpdate. */
async function emitReasoningDeltaCallback(inputs: AgentLoopInputs, text: string): Promise<void> {
  if (inputs.onDelta === undefined) return;
  const cb = inputs.onDelta;
  await safeCall(
    () => cb({ update: { type: "thinking-delta", text } }),
    undefined,
    "SendOptions.onDelta",
  );
}

/**
 * issue #48: close the reasoning channel with a single `thinking-completed` InteractionUpdate,
 * carrying the measured duration so a consumer can end its reasoning UI block.
 */
async function emitThinkingCompletedCallback(
  inputs: AgentLoopInputs,
  thinkingDurationMs: number,
): Promise<void> {
  if (inputs.onDelta === undefined) return;
  const cb = inputs.onDelta;
  await safeCall(
    () => cb({ update: { type: "thinking-completed", thinkingDurationMs } }),
    undefined,
    "SendOptions.onDelta",
  );
}
