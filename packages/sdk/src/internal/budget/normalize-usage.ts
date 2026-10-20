/**
 * normalizeUsage — convert provider-shaped raw `usage` object to
 * canonical `TokenUsage`. Ports Hermes Agent's `normalize_usage`
 * (reference/peer-agent/agent/usage_pricing.py:672-742).
 *
 * Handles 3 API shapes:
 *   - Anthropic Messages: 4 explicit buckets (input/output/cache_read/cache_creation).
 *   - OpenAI Chat Completions: prompt_tokens INCLUDES cache; subtract cached_tokens.
 *   - OpenAI Responses (Codex): input_tokens INCLUDES cache; same subtraction.
 *
 * Edge cases:
 *   - a peer#10266 — OpenAI-compat proxies (OpenRouter, a peer vendor AI Gateway,
 *     a peer) routing Claude expose Anthropic-style top-level fields
 *     (cache_read_input_tokens / cache_creation_input_tokens). Both
 *     locations are checked with top-level fallback.
 *   - Null/undefined fields → 0 via `int()` coerce.
 *   - String token counts → parsed via int.
 *   - Negative values → clamped to 0 (defensive against proxy bugs).
 *
 * @internal
 */

import type { TokenUsage } from "../../types/usage.js";

export type ApiMode = "anthropic_messages" | "openai_chat_completions" | "openai_responses";

function int(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  return 0;
}

function buildTotal(buckets: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  // total = visible input + cache buckets + output (reasoning counted via output)
  return (
    buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
  );
}

function omitUndefined(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    totalTokens: usage.totalTokens,
  };
}

/**
 * Guess which usage shape a provider reports, from its name alone.
 *
 * Matching is case-insensitive and exact — `"anthropic"`, `"claude"` and `"bedrock_anthropic"`
 * give `"anthropic_messages"`; `"openai-codex"` and `"codex"` give `"openai_responses"`. Every
 * other name, including ones this SDK has never seen, falls through to
 * `"openai_chat_completions"`. There is no unknown result, so a wrong guess is silent: it is
 * read as a Chat Completions payload, whose fields are absent, and the tokens come back as 0.
 *
 * The default is right for the OpenAI-compatible majority (openai, openrouter, deepseek, and the
 * compat endpoints of google, ollama and lmstudio). When it is not, pass `apiMode` to
 * `normalizeUsage` explicitly instead of relying on the name.
 */
export function inferApiMode(provider: string): ApiMode {
  const p = provider.toLowerCase();
  if (p === "anthropic" || p === "claude" || p === "bedrock_anthropic") {
    return "anthropic_messages";
  }
  if (p === "openai-codex" || p === "codex") return "openai_responses";
  // openai, openrouter, deepseek, google (compat), ollama (compat), lmstudio (compat), etc
  return "openai_chat_completions";
}

interface RawRecord {
  [k: string]: unknown;
}

/**
 * Convert a provider's raw `usage` object into the SDK's canonical `TokenUsage`.
 *
 * Never throws and never reports failure. `null`, `undefined` and any non-object argument return
 * all-zero usage, which is indistinguishable from a real response that used no tokens — so this
 * is not the place to detect a malformed payload.
 *
 * `opts.apiMode` selects the reader; when omitted it is derived from `opts.provider` via
 * `inferApiMode`, whose fallback is Chat Completions. Pass it explicitly for any provider whose
 * name does not identify its wire shape.
 *
 * The shapes differ in one way that matters: Anthropic reports cache tokens in buckets separate
 * from `input_tokens`, while both OpenAI shapes report a prompt total that already includes
 * them. For the OpenAI readers the cache buckets are subtracted, so `inputTokens` is always the
 * uncached portion and `inputTokens + cacheReadTokens + cacheWriteTokens` reconstructs the
 * provider's prompt total. The subtraction is floored at 0, so a payload whose cache counts
 * exceed its prompt total yields 0 rather than a negative.
 *
 * Every field is coerced: numbers are truncated toward zero, numeric strings are parsed, negative
 * and non-finite values become 0, and anything else becomes 0.
 *
 * `totalTokens` is computed here as input + output + both cache buckets; a `total_tokens` the
 * provider sent is ignored. Reasoning tokens are reported separately but are NOT added again —
 * providers already count them inside output. `cacheReadTokens`, `cacheWriteTokens` and
 * `reasoningTokens` are omitted from the result when they are 0, so absent means zero, not
 * unknown.
 *
 * Chat Completions also accepts Anthropic-style top-level `cache_read_input_tokens` /
 * `cache_creation_input_tokens`, which OpenAI-compatible proxies emit when they route Claude.
 * The nested `prompt_tokens_details` values win; the top-level fields are consulted only when
 * those are 0 or missing.
 */
export function normalizeUsage(
  rawUsage: unknown,
  opts: { provider: string; apiMode?: ApiMode },
): TokenUsage {
  if (rawUsage === null || rawUsage === undefined) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  if (typeof rawUsage !== "object") {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const raw = rawUsage as RawRecord;
  const mode = opts.apiMode ?? inferApiMode(opts.provider);

  if (mode === "anthropic_messages") return normalizeAnthropic(raw);
  if (mode === "openai_responses") return normalizeOpenAIResponses(raw);
  return normalizeOpenAIChat(raw);
}

function normalizeAnthropic(raw: RawRecord): TokenUsage {
  const inputTokens = int(raw.input_tokens);
  const outputTokens = int(raw.output_tokens);
  const cacheReadTokens = int(raw.cache_read_input_tokens);
  const cacheWriteTokens = int(raw.cache_creation_input_tokens);
  const usage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: 0,
    totalTokens: buildTotal({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }),
  };
  return omitUndefined(usage);
}

function normalizeOpenAIResponses(raw: RawRecord): TokenUsage {
  const inputTotal = int(raw.input_tokens);
  const outputTokens = int(raw.output_tokens);
  const inputDetails = (raw.input_tokens_details as RawRecord | undefined) ?? {};
  const outputDetails = (raw.output_tokens_details as RawRecord | undefined) ?? {};
  const cacheReadTokens = int(inputDetails.cached_tokens);
  const cacheWriteTokens = int(inputDetails.cache_creation_tokens);
  const reasoningTokens = int(outputDetails.reasoning_tokens);
  const inputTokens = Math.max(0, inputTotal - cacheReadTokens - cacheWriteTokens);
  const usage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: buildTotal({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }),
  };
  return omitUndefined(usage);
}

/** The prompt of a Chat Completions `usage` object, split the way {@link splitChatCompletionsPrompt} reports it. */
export interface ChatCompletionsPromptSplit {
  /** `prompt_tokens` minus both cache buckets, floored at 0; absent when `prompt_tokens` is. */
  readonly inputTokens?: number;
  /** Absent when the payload carries neither cache-read field. */
  readonly cacheReadTokens?: number;
  /** Absent when the payload carries neither cache-write field. */
  readonly cacheWriteTokens?: number;
}

/** Whether a raw usage field was sent with a value; a JSON `null` counts as not sent. */
function sent(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/**
 * The one reading of a Chat Completions prompt, shared by {@link normalizeUsage} and the streaming
 * chat-completions client (`openai.ts`), so the two cannot disagree on which cache field wins.
 *
 * `prompt_tokens` already counts the cache buckets, so they are subtracted: `inputTokens` is the
 * uncached portion, as Anthropic reports it, and `computeCost` bills each cached token once. The
 * nested `prompt_tokens_details` values win; the Anthropic-style top-level fields that proxies
 * routing Claude send (a peer#10266) are read only when the nested one is 0 or missing. Unlike
 * `normalizeUsage`, a field the payload never sent stays absent instead of becoming 0.
 *
 * @internal
 */
export function splitChatCompletionsPrompt(raw: RawRecord): ChatCompletionsPromptSplit {
  const details = (raw.prompt_tokens_details as RawRecord | undefined) ?? {};
  const bucket = (nested: unknown, topLevel: unknown): number | undefined =>
    sent(nested) || sent(topLevel) ? int(nested) || int(topLevel) : undefined;
  const cacheReadTokens = bucket(details.cached_tokens, raw.cache_read_input_tokens);
  const cacheWriteTokens = bucket(details.cache_write_tokens, raw.cache_creation_input_tokens);
  const cached = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  return {
    ...(sent(raw.prompt_tokens)
      ? { inputTokens: Math.max(0, int(raw.prompt_tokens) - cached) }
      : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

/**
 * The uncached slice of a prompt whose total already counts both cache buckets, floored at 0;
 * absent when the total is. `LlmFinish.inputTokens` is that slice on every client: the agent loop
 * adds the buckets back for the BudgetTracker input event and `computeCost` bills them at their own
 * rates, so a client passing the Responses API's `input_tokens` through counted them twice.
 *
 * @internal
 */
export function netOfCache(
  total: number | undefined,
  cacheReadTokens: number | undefined,
  cacheWriteTokens: number | undefined,
): number | undefined {
  return total === undefined
    ? undefined
    : Math.max(0, total - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0));
}

function normalizeOpenAIChat(raw: RawRecord): TokenUsage {
  const outputTokens = int(raw.completion_tokens);
  const completionDetails = (raw.completion_tokens_details as RawRecord | undefined) ?? {};
  const split = splitChatCompletionsPrompt(raw);
  const inputTokens = split.inputTokens ?? 0;
  const cacheReadTokens = split.cacheReadTokens ?? 0;
  const cacheWriteTokens = split.cacheWriteTokens ?? 0;
  const reasoningTokens = int(completionDetails.reasoning_tokens);
  const usage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: buildTotal({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }),
  };
  return omitUndefined(usage);
}
