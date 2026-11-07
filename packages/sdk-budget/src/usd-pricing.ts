/**
 * Built-in per-model USD pricing table (SDK 2.0 Phase 2 / sdk-budget T2.X).
 *
 * Prices are in USD per 1M tokens (input / output). Sources: each
 * provider's public pricing page; values verified 2026-06 against
 * the same tier used in sdk-core's `internal/budget/pricing-data.json`.
 *
 * The table is intentionally CONSERVATIVE — only the most-used models
 * land here. Consumers needing exhaustive coverage can supply an
 * override via `createUsdBudgetTracker({ pricing })`.
 *
 * @public
 */

/**
 * The two rates needed to price one model, in USD per 1,000,000 tokens.
 *
 * List prices only — cache rates are optional per model (unset means the input rate), no batch tier and no negotiated
 * rate, so a cost computed here is an upper bound for anyone on a discount and simply wrong for a
 * provider that bills per request.
 *
 * @public
 */
export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMillionUsd: number;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMillionUsd: number;
  /** USD per 1,000,000 cache-read tokens. Omitted: cache reads are priced at the input rate. */
  readonly cacheReadPerMillionUsd?: number;
  /** USD per 1,000,000 cache-write tokens. Omitted: cache writes are priced at the input rate. */
  readonly cacheWritePerMillionUsd?: number;
}

/**
 * The nine models this package prices out of the box, keyed by the exact `model` string a
 * `BudgetUsageEvent` carries: four OpenAI, three Anthropic, two Google.
 *
 * Lookup is exact-match. No prefix stripping, no aliasing, no fuzzy fallback — `"gpt-4o"` and
 * `"openrouter/openai/gpt-4o"` both MISS the `"openai/gpt-4o"` entry, and a miss means unknown
 * cost, which under a `maxUsd` cap denies the run. Pass overrides through
 * `createUsdBudgetTracker({ pricing })` rather than expecting a match.
 *
 * Prices are a dated snapshot (verified 2026-06) of public list prices and DRIFT — treat a total
 * derived from them as an estimate, not as a bill. `Object.freeze` here is shallow: the map cannot
 * gain keys, but the `ModelPricing` objects inside it are mutable.
 *
 * @public
 */
export const BUILTIN_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // OpenAI / OpenRouter aliases
  "openai/gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  "openai/gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "openai/gpt-4-turbo": { inputPerMillionUsd: 10, outputPerMillionUsd: 30 },
  "openai/gpt-3.5-turbo": { inputPerMillionUsd: 0.5, outputPerMillionUsd: 1.5 },
  // Anthropic / Claude
  "anthropic/claude-3-5-sonnet-latest": { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
  "anthropic/claude-3-5-haiku-latest": { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 0.08, cacheWritePerMillionUsd: 1 },
  "anthropic/claude-3-opus-latest": { inputPerMillionUsd: 15, outputPerMillionUsd: 75, cacheReadPerMillionUsd: 1.5, cacheWritePerMillionUsd: 18.75 },
  // Google
  "google/gemini-1.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 },
  "google/gemini-1.5-flash": { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
});

/**
 * Compute USD cost for a single token event.
 *
 * Returns `undefined` (NOT `0`, NOT throws) when the model is UNKNOWN — its
 * cost is genuinely unknown, and coercing it to `$0` would be dishonest (cost
 * contract `D377-cost-status-closed-enum.md`: amount-unknown ≠ `$0`). Consumers
 * who want a price for a niche model supply an override via
 * `createUsdBudgetTracker({ pricing })`. A KNOWN model with zero/invalid tokens
 * returns `0` — that is a real, known `$0`.
 */
export function computeUsdCost(
  pricing: Readonly<Record<string, ModelPricing>>,
  model: string,
  type: "input" | "output" | "cache_read" | "cache_write",
  tokens: number,
): number | undefined {
  const entry = pricing[model];
  if (entry === undefined) return undefined;
  const ratePerMillion = rateFor(entry, type);
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * ratePerMillion;
}

function rateFor(entry: ModelPricing, type: "input" | "output" | "cache_read" | "cache_write"): number {
  if (type === "output") return entry.outputPerMillionUsd;
  if (type === "cache_read") return entry.cacheReadPerMillionUsd ?? entry.inputPerMillionUsd;
  if (type === "cache_write") return entry.cacheWritePerMillionUsd ?? entry.inputPerMillionUsd;
  return entry.inputPerMillionUsd;
}
