/**
 * Public compaction / context-management helpers (M2-1, extended V3-3).
 *
 * Promotes the SDK's compaction capability to a public surface so consumers can
 * compact a transcript, mark/filter conversation checkpoints, and detect
 * context-overflow — without reaching into `internal/`.
 *
 * Two recent-window modes (V3-3):
 *  - `keepRecent` (turn-count, default) — keeps the last N turns verbatim and
 *    always preserves leading system PROMPTS; reuses the internal
 *    `selectCompressionWindow` (no second algorithm).
 *  - `keepTokens` (token-budget) — keeps the trailing turns whose accumulated
 *    `estimateTokens` fits the budget (theocode `splitTranscript` semantics). In
 *    this mode leading system prompts are NOT special-cased (D6).
 *
 * Summarization is delegated to a caller-supplied callback (which receives the
 * older window + the summary template). With `failSafe`, a thrown summarizer
 * returns the ORIGINAL transcript + a structured warn (compaction is an
 * optimization, never a cause of data loss); without it, the error propagates.
 *
 * Public from the `@theokit/sdk/compaction` sub-path.
 */

import { TheokitAgentError } from "./errors.js";
import { diag } from "./internal/diagnostics.js";
import { selectCompressionWindow } from "./internal/runtime/compression/compression-helpers.js";
import { redactSecrets } from "./internal/security/redact.js";

/**
 * Minimal message shape for compaction/compression input. THE canonical public origin (leaf type —
 * rollup-plugin-dts cannot re-export types from internal modules into entry bundles; M42 lesson).
 *
 * @public
 */
export interface CompressibleMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Sentinel prefix marking a conversation checkpoint turn. A visible, structured,
 * prose-unlikely token (no invisible/control bytes — safe to persist and to read
 * in source). Only {@link buildCheckpoint} should produce content beginning with it.
 */
export const CHECKPOINT_MARKER = "[[theokit:checkpoint]] ";

/**
 * The 7-section summary template handed to the `summarize` callback (theocode
 * parity shape). Every header is always present so the summarizer cannot silently
 * drop a category; the model is told to preserve file paths, commands, and error
 * text verbatim. Override per-call via {@link CompactTranscriptOptions.summaryTemplate}.
 */
export const SUMMARY_TEMPLATE = `Summarize the conversation so far into these sections (keep every header even if empty):

## Goal
What the user is ultimately trying to achieve.

## Constraints
Hard requirements, conventions, and rules stated.

## Progress
What has been done so far.

## Decisions
Choices made and their rationale.

## Next
The immediate next steps.

## Critical
Anything that MUST NOT be forgotten (preserve verbatim: error messages, exact values).

## Files
File paths touched or referenced (verbatim).`;

/** Reject an empty marker — it would match every turn via `startsWith("")` (EC-3). */
function assertMarker(marker: string): void {
  if (marker === "") {
    throw new TheokitAgentError("compaction marker must be non-empty", {
      code: "invalid_argument",
    });
  }
}

/** True for a real system prompt — a `system` turn that is NOT a checkpoint marker. */
function isSystemPrompt(message: CompressibleMessage, marker: string): boolean {
  return message.role === "system" && !message.content.startsWith(marker);
}

/** Carried split: leading system prompts (preserved), the older window, the verbatim tail. */
interface TranscriptSplit {
  systemPrompts: CompressibleMessage[];
  head: CompressibleMessage[];
  recent: CompressibleMessage[];
}

/**
 * Token-budget split (theocode `splitTranscript`): walk from the END accumulating
 * `estimateTokens` until `keepTokens` is exceeded; everything older is the head.
 * Always keeps ≥ 1 recent turn. No system-prompt special-casing (D6).
 */
function selectByTokenBudget(
  messages: CompressibleMessage[],
  keepTokens: number,
): { head: CompressibleMessage[]; recent: CompressibleMessage[] } {
  let acc = 0;
  let splitIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    acc += estimateTokens(messages[i]?.content ?? "");
    if (acc > keepTokens && i < messages.length - 1) {
      splitIndex = i + 1;
      break;
    }
    splitIndex = i;
  }
  return { head: messages.slice(0, splitIndex), recent: messages.slice(splitIndex) };
}

/** Turn-count split (M2): preserve leading system prompts; window the rest by `keepRecent`. */
function splitByRecent(
  messages: CompressibleMessage[],
  keepRecent: number,
  marker: string,
): TranscriptSplit {
  const systemPrompts = messages.filter((m) => isSystemPrompt(m, marker));
  const rest = messages.filter((m) => !isSystemPrompt(m, marker));
  const { toCompress, toPreserve } = selectCompressionWindow(rest, keepRecent);
  return { systemPrompts, head: toCompress, recent: toPreserve };
}

/** Options for {@link compactTranscript}. */
export interface CompactTranscriptOptions {
  /** Trailing turns preserved verbatim by COUNT (default 6). Ignored when `keepTokens` is set. */
  keepRecent?: number;
  /**
   * Trailing turns preserved verbatim by TOKEN BUDGET (theocode mode). When set,
   * takes precedence over `keepRecent` and disables system-prompt preservation (D6).
   */
  keepTokens?: number;
  /** Checkpoint marker (default {@link CHECKPOINT_MARKER}). Must be non-empty. */
  marker?: string;
  /** Summary template passed to `summarize` (default {@link SUMMARY_TEMPLATE}). */
  summaryTemplate?: string;
  /** Summarize the older window into one turn; if omitted, the older window is dropped. */
  summarize?: (older: CompressibleMessage[], template: string) => Promise<CompressibleMessage>;
  /**
   * When true, a thrown `summarize` returns the ORIGINAL transcript + a structured
   * warn (compaction never loses data). Default false: the error propagates.
   */
  failSafe?: boolean;
}

/** Sentinel returned by {@link runSummarize} when fail-safe swallowed a throw. */
const FAILSAFE_ABORT = Symbol("failsafe-abort");

/** Run the summarizer; on throw, either propagate or (fail-safe) warn + signal abort. */
async function runSummarize(
  summarize: NonNullable<CompactTranscriptOptions["summarize"]>,
  head: CompressibleMessage[],
  template: string,
  failSafe: boolean,
): Promise<CompressibleMessage | typeof FAILSAFE_ABORT> {
  try {
    return await summarize(head, template);
  } catch (err) {
    if (!failSafe) throw err;
    // Unbreakable Rule 8 — never fail silently. The breadcrumb points at the root
    // cause when a summarizer fails every turn and context grows unchecked. The
    // summarizer is caller-supplied, so its error text is routed through
    // `redactSecrets` (ADR D68 — no unredacted output sink in src/).
    // theokit#147 — through the interceptable channel. A summarizer failing every turn is exactly
    // the breadcrumb a TUI host wants in its own panel, not smeared across its alternate screen.
    diag(
      `[compaction] summarizer failed — proceeding uncompacted: ${redactSecrets(err instanceof Error ? err.message : String(err))}\n`,
    );
    return FAILSAFE_ABORT;
  }
}

/**
 * Compact a transcript. In `keepRecent` mode (default) the last `keepRecent` turns
 * are kept verbatim and leading system PROMPTS preserved; in `keepTokens` mode the
 * trailing turns within the token budget are kept (no system special-casing, D6).
 * The older window is summarized (via `summarize`, receiving the template) or
 * dropped. Never mutates the input.
 */
export async function compactTranscript(
  messages: CompressibleMessage[],
  options: CompactTranscriptOptions = {},
): Promise<CompressibleMessage[]> {
  const marker = options.marker ?? CHECKPOINT_MARKER;
  assertMarker(marker);
  const split =
    options.keepTokens != null
      ? { systemPrompts: [], ...selectByTokenBudget(messages, options.keepTokens) }
      : splitByRecent(messages, options.keepRecent ?? 6, marker);
  if (split.head.length === 0) {
    return [...messages];
  }
  if (!options.summarize) {
    return [...split.systemPrompts, ...split.recent];
  }
  const template = options.summaryTemplate ?? SUMMARY_TEMPLATE;
  const summary = await runSummarize(
    options.summarize,
    split.head,
    template,
    options.failSafe ?? false,
  );
  if (summary === FAILSAFE_ABORT) {
    return [...messages];
  }
  return [...split.systemPrompts, summary, ...split.recent];
}

/**
 * Build a checkpoint marker turn (a `system` turn whose content starts with
 * `marker`, default {@link CHECKPOINT_MARKER}). `marker` must be non-empty.
 */
export function buildCheckpoint(
  label?: string,
  marker: string = CHECKPOINT_MARKER,
): CompressibleMessage {
  assertMarker(marker);
  return { role: "system", content: marker + (label ?? "") };
}

/** Options for {@link filterFromLatestCheckpoint}. */
export interface FilterCheckpointOptions {
  /** Marker to scan for (default {@link CHECKPOINT_MARKER}). */
  marker?: string;
  /**
   * `'after'` (default, M2) returns turns AFTER the latest marker (exclusive);
   * `'from'` (theocode) returns turns FROM the latest marker (inclusive).
   */
  include?: "after" | "from";
}

/**
 * Return the turns relative to the most recent checkpoint marker (all turns if
 * none). `include: 'after'` (default) excludes the checkpoint; `'from'` includes
 * it (the summary stands in for the pruned head). Never mutates the input.
 */
export function filterFromLatestCheckpoint(
  messages: CompressibleMessage[],
  options: FilterCheckpointOptions = {},
): CompressibleMessage[] {
  const marker = options.marker ?? CHECKPOINT_MARKER;
  const offset = options.include === "from" ? 0 : 1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.content.startsWith(marker)) {
      return messages.slice(i + offset);
    }
  }
  return [...messages];
}

/**
 * True iff `err` is a {@link TheokitAgentError} (or subclass) reporting a
 * context-window-exceeded condition (the typed `context_too_long` code). Reads
 * both `code` (set by provider mappers) and `metadata.code` (the preferred field)
 * — never a brittle message regex.
 */
export function isContextOverflowError(err: unknown): boolean {
  return (
    err instanceof TheokitAgentError &&
    (err.code === "context_too_long" || err.metadata?.code === "context_too_long")
  );
}

/**
 * M77 — the margin is outside `(0, 1]`. Typed, because a margin > 1 would GROW the assumed window,
 * which is the unsafe direction: `shouldCompact` is monotonically decreasing in `contextWindow`, so
 * overestimating it makes the trigger fire too late and the context overflow.
 */
export class ContextWindowMarginError extends TheokitAgentError {
  constructor(readonly margin: number) {
    super(
      `context-window margin must be in (0, 1], got ${String(margin)}. ` +
        `A margin above 1 grows the assumed window and delays compaction past the real limit.`,
      { code: "invalid_context_window_margin" },
    );
  }
}

/**
 * M77 — default safety margin on the context window.
 *
 * `0.95` is not a guess: it is the single reference's value. Codex ships
 * `effective_context_window_percent: 95` (`models-manager/src/model_info.rs:158`) and never budgets
 * against 100% of a window. Being MULTIPLICATIVE, it stays conservative at any window size, which a
 * fixed subtraction would not.
 */
export const CONTEXT_WINDOW_MARGIN = 0.95;

/**
 * M77 — the floor used ONLY when neither the catalog nor the caller knows the window.
 *
 * Honest about its own weakness. This number has **one** source (the M77 milestone text); the search
 * for a second one failed, because the reference has no fallback at all — Codex returns `Option` and
 * its callers early-return (`core/src/session/turn_context.rs:213`, `core/src/compact_remote.rs:374`).
 *
 * It is conservative only UPWARD. For a model whose real window is larger, budgeting against 128k
 * compacts early — wasteful but safe. For a model whose real window is SMALLER (an 8k or 32k model
 * absent from the catalog), it compacts too late and the context still overflows. That residual risk
 * is real and is why {@link resolveEffectiveContextWindow} never lets this floor compete with a known
 * catalog value, and why the `compaction_fallback` event exists: a surface can show that the budget is
 * a guess instead of the user finding out when the provider rejects the request.
 */
export const CONTEXT_WINDOW_FLOOR = 128_000;

/** Where the effective window came from — carried into the M77 structured event. */
export type ContextWindowSource = "override" | "catalog" | "fallback";

/** Input to {@link resolveEffectiveContextWindow}. */
export interface EffectiveContextWindowInput {
  /** Caller-supplied window, in tokens. Clamped by `catalog` when both are present. */
  readonly override?: number | undefined;
  /** The model's window from the catalog, in tokens. Absent when the model is unknown. */
  readonly catalog?: number | undefined;
  /** Safety margin in `(0, 1]`. Codex uses 0.95 (`model_info.rs:158`). */
  readonly margin: number;
  /** Conservative floor used ONLY when neither `override` nor `catalog` is available. */
  readonly floor?: number | undefined;
}

/** Result of {@link resolveEffectiveContextWindow}. */
export interface EffectiveContextWindow {
  /** The window to budget against, after clamp and margin. */
  readonly window: number;
  /** Which input won — `"fallback"` means neither override nor catalog was available. */
  readonly source: ContextWindowSource;
  /** `true` when an `override` above the catalog window was clamped down to it. */
  readonly clamped: boolean;
}

/**
 * Absolute cap on a declared context window, applied when no catalog entry exists to compare against.
 *
 * **10M**, not 2M. The first version used 2M on the rationale that it sat "comfortably above the
 * largest published window" — adversarial review measured the opposite: Llama 4 Scout publishes
 * **10M**, and it arrives precisely via OpenRouter, the provider **without** a catalog, which is the
 * case this cap exists to cover. The user would have silently lost 80% of the declared window.
 *
 * The cap still serves what motivates it — one extra zero on 400k gives 4M, which passes; two zeros
 * give 40M, which does not. A limit that rejects legitimate configuration is worse than no limit,
 * because failing OPEN is visible when it happens and silently losing 80% is not.
 */
export const ABSOLUTE_CONTEXT_WINDOW_CAP = 10_000_000;

/**
 * Resolve the window to budget against — the fail-SAFE replacement for reading the catalog directly.
 *
 * Today `post-run-lifecycle.ts` reads `getCatalogModelInfo(model)?.limit?.context` and, when that is
 * `undefined`, auto-compaction simply never fires. That is fail-OPEN: the context grows until the
 * provider rejects the request. (The comment there calls it "fail-safe" — M77 corrects it.)
 *
 * Three techniques, two of them borrowed from the single reference:
 *
 *  1. **Override, CLAMPED by the catalog** — Codex `models-manager/src/model_info.rs:26-31` lets
 *     config override the window but limits it with `context_window.min(max_context_window)`.
 *     Without the clamp, declaring 999k on a 200k model reopens the overflow through another door.
 *  2. **Multiplicative margin** — Codex `model_info.rs:158` (`effective_context_window_percent: 95`)
 *     never budgets against 100% of the window. Being multiplicative, it is conservative for ANY
 *     window size.
 *  3. **Floor, only when nothing is known** — deliberately NOT a blanket default. A fixed floor is
 *     conservative only upward: applied to a small model it would inflate the assumed window and
 *     reproduce the very fail-open this function exists to close. Hence the floor never competes
 *     with a known catalog value.
 *
 * Pure — no catalog lookup, no I/O. The caller supplies the numbers, mirroring `shouldCompact`.
 */
export function resolveEffectiveContextWindow(
  input: EffectiveContextWindowInput,
): EffectiveContextWindow {
  if (!(input.margin > 0) || input.margin > 1) {
    throw new ContextWindowMarginError(input.margin);
  }

  const withMargin = (raw: number): number => Math.floor(raw * input.margin);

  if (input.override !== undefined) {
    // The catalog is the preferred cap; without it the ABSOLUTE cap applies.
    //
    // M95 (adversarial review of M94) — the previous version clamped **only** when a catalog entry
    // existed, and the whole reason the `contextWindow` key exists is the model that has NO entry
    // (OpenRouter has zero). So the clamp was missing in exactly the case that justifies the
    // feature, while the documentation — including an already-published CHANGELOG — stated without
    // qualification that "declaring 10M does not blow past the provider".
    //
    // The concrete scenario is one extra zero: `context_window = 4000000`. The only guard was a
    // `.positive().int()`, which sets no upper bound. The agent would never compact until the
    // provider refused the turn — the silent fail-OPEN that M77 exists to prevent.
    const cap = input.catalog ?? ABSOLUTE_CONTEXT_WINDOW_CAP;
    const clamped = input.override > cap;
    return { window: withMargin(clamped ? cap : input.override), source: "override", clamped };
  }

  if (input.catalog !== undefined) {
    return { window: withMargin(input.catalog), source: "catalog", clamped: false };
  }

  return { window: withMargin(input.floor ?? 0), source: "fallback", clamped: false };
}

/** Input to {@link shouldCompact}: an estimate, the model's window, and reserved headroom. */
export interface ShouldCompactInput {
  /** Estimated token count of the next request (e.g. from {@link estimateTokens}). */
  readonly estimated: number;
  /** The model's total context window, in tokens. */
  readonly contextWindow: number;
  /** Tokens to reserve as headroom (output + safety margin). */
  readonly buffer: number;
  /**
   * Tokens reserved for the model's response generation, SEPARATE from `buffer`.
   * Default 0 — omitting it preserves the legacy
   * `estimated >= contextWindow - buffer` result.
   */
  readonly maxOutput?: number;
}

/**
 * Characters per token in the tokenizer-free estimate below.
 *
 * Exported so the ratio has ONE owner. It used to be a named constant in `built-in-processors.ts`
 * and an inlined `4` here, with both `estimateTokens` functions `@public` from two different package
 * entry points — so tuning the ratio, or switching to code points instead of UTF-16 units (the
 * caveat both docblocks already carried), would have silently diverged them.
 *
 * @public
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Tokenizer-free token estimate via the conventional ~4-chars-per-token
 * heuristic: `ceil(text.length / CHARS_PER_TOKEN)`. `""` → 0; any non-empty text → ≥ 1.
 * A cheap PRE-CALL gate for {@link shouldCompact} — NOT exact tokenization
 * (a consumer needing exactness supplies their own tokenizer). Uses UTF-16
 * `.length` (code units), so multibyte text is approximate.
 *
 * `built-in-processors.ts` re-exports this under the same name, so both entry points keep working
 * and there is one implementation behind them.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Decide BEFORE sending whether to compact: `true` when the `estimated` token
 * count leaves less than `buffer` headroom in the `contextWindow`
 * (`estimated >= contextWindow - buffer`). A `buffer >= contextWindow`
 * (non-positive threshold) always returns `true`. Pure — the caller supplies
 * the window (e.g. from `resolveModelCapabilities`), keeping this decoupled
 * from the per-model catalog.
 */
export function shouldCompact(input: ShouldCompactInput): boolean {
  return input.estimated >= input.contextWindow - input.buffer - (input.maxOutput ?? 0);
}

export type { CompressionConfig } from "./internal/runtime/compression/compression-config.js";
export { CompressionModelUnresolvedError } from "./internal/runtime/compression/compression-model-registry.js";
// `CompressionFailedError` is exported from `./errors`, not here: compression-summarizer.ts
// imports `CompressibleMessage` from THIS module, so exporting from it closes a cycle madge
// rejects (tests/architecture/no-cycles-at-all.test.ts). The errors entry is where a consumer
// looks for a typed error anyway.
