/**
 * M50 (agent-builder) — session-transcript compaction.
 *
 * The mechanism:
 *   - the replacement history = recent USER messages verbatim (newest→oldest under a token budget;
 *     prior summaries filtered by marker) + ONE summary message with a textual marker prefix,
 *     injected as `role:"user"` (`build_compacted_history`, compact.rs:589-663);
 *   - persistence is APPEND-ONLY: a `compact_boundary` record becomes the new DAG root and the
 *     replacement messages are chained onto it — resume replays boundary→replacement→suffix
 *     (equivalent of `CompactedItem.replacement_history`, rollout is never truncated);
 *   - a failing summarizer leaves the transcript UNTOUCHED (typed error; no partial state).
 *
 * The summarizer is dependency-injected: tests pass a deterministic fake; the public
 * `Agent.compact` wires the ADR-D440 compression summarizer (its first real caller).
 */

import { type CompressibleMessage, estimateTokens } from "../../compaction.js";
import type { SessionStore } from "../../types/session-store.js";
import { diag } from "../diagnostics.js";
import { globalSingleton } from "../global-singleton.js";
import { resolveProviderChain } from "../llm/router.js";
import {
  detectPrimaryProvider,
  inferProviderFromApiKey,
} from "../local-agent/real-local-run-provider.js";
import { reconstructMessages, SessionTranscript } from "../persistence/session-transcript.js";
import { getProviderProfile, registerBuiltins } from "../providers/index.js";
import { resolveCompressionModel } from "../runtime/compression/compression-model-registry.js";
import { compressConversationWindow } from "../runtime/compression/compression-summarizer.js";
import { invalidateSessionCache } from "./session-cache.js";

/** Textual marker prefixing every compact summary (Codex `SUMMARY_PREFIX` analog). */
export const COMPACT_SUMMARY_MARKER = "[[theokit:compact-summary]]";

/** Budget of VERBATIM user messages preserved in the replacement (Codex `COMPACT_USER_MESSAGE_MAX_TOKENS`). */
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

export interface CompactLocation {
  cwd: string;
  agentId: string;
  model?: string;
}

export interface CompactResult {
  preTokens: number;
  postTokens: number;
}

/** Is this message a summary produced by a PRIOR compaction? (filtered from verbatim preservation). */
export function isCompactSummary(content: string): boolean {
  // M56 — goal-continuation boilerplate is loop plumbing, not user knowledge: preserving N copies of
  // the template verbatim would crowd out real user messages from the preservation budget.
  return (
    content.startsWith(COMPACT_SUMMARY_MARKER) ||
    content.startsWith("[[theokit:goal-continuation]]")
  );
}

/**
 * Extract the text of an LlmMessage: content is `LlmContentPart[]` — concatenate the `text` parts
 * (tool_call / tool_result / image parts are skipped for compaction purposes).
 */
function plainText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter(
      (p): p is { type: string; text: string } =>
        p !== null &&
        typeof p === "object" &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * What a pre-compaction handler is told, and what it is given to bail out with.
 *
 * `trigger` is READ from the compaction that is happening, never inferred from the call site: the
 * inference would be right today and silently wrong the first time a third caller appears.
 *
 * @public
 */
export interface PreCompactContext {
  /** The messages about to be summarised — what the handler gets a last look at. */
  readonly messages: readonly CompressibleMessage[];
  /** `manual` when a person asked, `auto` when a usage threshold did. */
  readonly trigger: "manual" | "auto";
  /** Aborted when the bound fires, so a long handler can stop rather than be merely ignored. */
  readonly signal: AbortSignal;
}

/** @public */
export type PreCompactHandler = (ctx: PreCompactContext) => void | Promise<void>;

/**
 * The bound, in milliseconds, when the caller does not choose one.
 *
 * Same value as `@theokit/agents`' `withPreCompaction`, because B-082's requirement is the same
 * contract as B-002 and not a second one.
 */
export const DEFAULT_PRE_COMPACT_TIMEOUT_MS = 30_000;

/**
 * Run the handler with a bound, and REPORT rather than throw.
 *
 * Compaction proceeds whatever the handler does. That is the load-bearing half of the contract: a
 * hook that could block would turn a consumer's bug into a runtime that cannot reclaim its context,
 * and a runtime that cannot compact eventually cannot run at all.
 *
 * The signal is aborted BEFORE the bound rejects, so a handler watching it can stop rather than be
 * abandoned in the background still holding whatever it was holding.
 */
async function runPreCompactBounded(
  handler: PreCompactHandler,
  ctx: Omit<PreCompactContext, "signal">,
  timeoutMs: number,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(handler({ ...ctx, signal: controller.signal })),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`pre-compaction handler exceeded ${timeoutMs}ms and was abandoned`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    onError?.(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Compact one session transcript: summarize the reconstructed history, then append (append-only)
 * a `compact_boundary` + the replacement chain (recent user messages verbatim + marker'd summary).
 *
 * @throws whatever `summarize` throws — with the transcript guaranteed untouched.
 */
// Pre-existing (M50). B-082 moved this suppression back onto the function it covers: inserting the
// seam types above it stranded the directive on an interface that never needed one, which Biome
// reported as unused while the real target went unguarded. The directive must be the LAST comment
// line before its target — the same adjacency rule an eslint-disable follows, learned twice today.
// The seam is extracted into `runPreCompactBounded` rather than inlined, so it adds no branches.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see the paragraph above
export async function compactSessionTranscript(opts: {
  store: SessionStore;
  loc: CompactLocation;
  sessionId: string;
  trigger: "manual" | "auto";
  summarize: (messages: readonly CompressibleMessage[]) => Promise<string>;
  /**
   * Work to run before the transcript is rewritten, on the path the caller actually took.
   *
   * Absent, nothing is entered and the path is byte-identical to before B-082 — asserted by a test
   * rather than left as an inference.
   */
  onPreCompact?: PreCompactHandler;
  /** Where a handler's failure or timeout is reported. Compaction proceeds either way. */
  onPreCompactError?: (error: unknown) => void;
  /** Overrides {@link DEFAULT_PRE_COMPACT_TIMEOUT_MS}. */
  preCompactTimeoutMs?: number;
}): Promise<CompactResult> {
  const prior = await opts.store.readRecords(opts.loc.agentId);
  const history = reconstructMessages(prior);

  const compressible: CompressibleMessage[] = [];
  for (const m of history) {
    const text = plainText(m.content);
    if (
      text !== undefined &&
      (m.role === "user" || m.role === "assistant" || m.role === "system")
    ) {
      compressible.push({ role: m.role, content: text });
    }
  }
  const preTokens = estimateTokens(compressible.map((m) => m.content).join("\n"));

  // B-082: the seam, placed after the compressible set is built and before anything is written.
  // The handler sees exactly what will be summarised — the same thing `withPreCompaction` hands its
  // handler on the agents-layer path, which is what keeps one contract instead of two.
  if (opts.onPreCompact !== undefined) {
    await runPreCompactBounded(
      opts.onPreCompact,
      { messages: compressible, trigger: opts.trigger },
      opts.preCompactTimeoutMs ?? DEFAULT_PRE_COMPACT_TIMEOUT_MS,
      opts.onPreCompactError,
    );
  }

  // Summarize FIRST — a throwing summarizer must leave the transcript untouched (fail-safe).
  const summaryBody = await opts.summarize(compressible);

  // Recent user messages verbatim: newest→oldest under the budget, prior summaries filtered.
  const preserved: string[] = [];
  let budget = 0;
  for (let i = compressible.length - 1; i >= 0; i--) {
    const m = compressible[i];
    if (m === undefined || m.role !== "user" || isCompactSummary(m.content)) continue;
    const cost = estimateTokens(m.content);
    if (budget + cost > COMPACT_USER_MESSAGE_MAX_TOKENS) {
      // M50 review F8 — Codex TRUNCATES the overflowing message and keeps the piece
      // (compact.rs:620-629); dropping it entirely loses the most-recent context verbatim.
      const remaining = COMPACT_USER_MESSAGE_MAX_TOKENS - budget;
      if (remaining > 50) {
        preserved.unshift(`${m.content.slice(0, remaining * 4)}\n[...truncated for compaction...]`);
      }
      break;
    }
    budget += cost;
    preserved.unshift(m.content); // chronological order in the replacement
  }

  const summary = `${COMPACT_SUMMARY_MARKER}\n${summaryBody}`;

  // Append-only write: boundary (new root) + replacement chained onto it.
  const transcript = SessionTranscript.fromRecords(prior, {
    cwd: opts.loc.cwd,
    sessionId: opts.sessionId,
    model: opts.loc.model ?? "unknown",
  });
  transcript.appendCompactBoundary({ preTokens, trigger: opts.trigger });
  for (const text of preserved) transcript.appendUserTurn(text);
  transcript.appendUserTurn(summary);
  const delta = transcript.records().slice(prior.length);
  await opts.store.appendRecords(opts.loc.agentId, delta);

  // M50 review F1 — the live process must FEEL the compaction: drop the in-memory session cache so
  // the next send re-hydrates from disk (replacement + later turns) instead of replaying the full
  // pre-compact history until a restart.
  invalidateSessionCache(opts.loc.cwd, opts.loc.agentId);

  const postTokens = estimateTokens([...preserved, summary].join("\n"));
  return { preTokens, postTokens };
}

/**
 * M50 review F6 (fixed by the probe) — the summarizer's provider route, PURE and unit-tested.
 * Precedence mirrors the run's M4 rule exactly:
 *   1. an EXPLICIT credential's provider wins (an sk-or- key + `openai/…` model must summarize via
 *      OpenRouter — the key is the ground truth of which endpoint gets called);
 *   2. else a model prefix with a REGISTERED profile (the oauth `openai-chatgpt` builtin owns its
 *      auth; the M45 fleet resolves its own env vars) routes through that profile;
 *   3. else the ENV-detected provider (fresh process, aggregator credential in env).
 * `fullSlug` marks aggregator routes (provider ≠ prefix): the agent's slug passes unstripped.
 */
export function resolveSummarizerRoute(opts: {
  keyProvider: string | undefined;
  modelPrefix: string | undefined;
  prefixHasProfile: boolean;
  envProvider: string;
}): { provider: string; fullSlug: boolean } {
  const provider =
    opts.keyProvider ??
    (opts.prefixHasProfile && opts.modelPrefix !== undefined ? opts.modelPrefix : opts.envProvider);
  return { provider, fullSlug: provider !== opts.modelPrefix };
}

// ─── Default summarizer (the ADR-D440 subsystem's first real caller) ─────────────────────────────

/**
 * Build the default summarizer for `Agent.compact`: the D440 `compressConversationWindow`
 * (aux-LLM summarization with typed failure) driven by a router-resolved LLM client. The
 * compression model resolves via the D440 registry with the agent's own model as fallback.
 */
export function buildDefaultSummarizer(opts: {
  agentModel: string;
  apiKey?: string;
}): (messages: readonly CompressibleMessage[]) => Promise<string> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing (M50) — flagged only because this file was touched by an unrelated one-line M56 change; refactor tracked separately.
  return async (messages) => {
    // Provider resolution mirrors the RUN's own (M4 rule: the explicit API key outranks the model
    // prefix — an sk-or- key + openai/gpt model must summarize via OpenRouter too). Using anything
    // else 401s in real setups (proven live in the M50 probe).
    registerBuiltins();
    const modelPrefix = opts.agentModel.includes("/")
      ? opts.agentModel.slice(0, opts.agentModel.indexOf("/"))
      : undefined;
    const prefixProfile = modelPrefix !== undefined ? getProviderProfile(modelPrefix) : undefined;
    // A prefix profile is only USABLE when its credentials are actually resolvable here: oauth/none
    // profiles own their auth; api_key profiles need one of their env vars set. A profile without a
    // usable credential (e.g. `openai` builtin with only OPENROUTER_API_KEY in env) must NOT win.
    const prefixUsable =
      prefixProfile !== undefined &&
      (prefixProfile.authType !== "api_key" ||
        prefixProfile.envVars.some((v) => (process.env[v] ?? "").length > 0));
    const route = resolveSummarizerRoute({
      keyProvider: inferProviderFromApiKey(opts.apiKey),
      modelPrefix,
      prefixHasProfile: prefixUsable,
      envProvider: detectPrimaryProvider(),
    });
    const provider = route.provider;

    let model: string;
    if (route.fullSlug) {
      // Aggregator route (e.g. OpenRouter): pass the agent's full slug through unstripped.
      model = opts.agentModel;
    } else {
      try {
        model = resolveCompressionModel(opts.agentModel);
      } catch {
        model = opts.agentModel; // registry miss — summarize with the agent's own model
      }
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing (M50) — flagged only because this file was touched by an unrelated one-line M56 change; refactor tracked separately.
    const callLlm = async (m: string, system: string, user: string): Promise<string> => {
      const chain = resolveProviderChain({
        primary: provider,
        ...(opts.apiKey !== undefined ? { apiKeys: { [provider]: [opts.apiKey] } } : {}),
      });
      const client = chain[0];
      if (client === undefined) throw new Error(`no LLM client for provider "${provider}"`);
      const controller = new AbortController();
      let text = "";
      const stream = client.stream(
        { model: m, system, messages: [{ role: "user", content: [{ type: "text", text: user }] }] },
        controller.signal,
      );
      for (;;) {
        const step = await stream.next();
        if (step.done === true) break;
        if (step.value.type === "text_delta") text += step.value.text;
        if (step.value.type === "error") throw new Error(step.value.message);
      }
      return text;
    };

    const summary = await compressConversationWindow({ messages: [...messages], model, callLlm });
    return summary.content;
  };
}

// ─── Auto-compaction (Codex formula: fire at usage_real >= (cw*9)/10) ────────────────────────────

/**
 * Should auto-compaction fire? Codex parity: `token_limit_reached` when real usage crosses 90% of
 * the model's context window (`context_window.rs:74-79`; limit default `(cw*9)/10`,
 * `openai_models.rs:459-469`). Missing inputs (no usage reported / model absent from the catalog)
 * NEVER fire — fail-safe toward "do nothing".
 */
export function shouldAutoCompact(opts: {
  usageTotal?: number | undefined;
  contextWindow?: number | undefined;
}): boolean {
  if (opts.usageTotal === undefined || opts.contextWindow === undefined) return false;
  if (opts.usageTotal <= 0 || opts.contextWindow <= 0) return false;
  return opts.usageTotal >= Math.floor((opts.contextWindow * 9) / 10);
}

/** Anti-cascade bookkeeping: last turn we ATTEMPTED an auto-compact, per agent (globalThis — M44 B1). */
const autoCompactAttempts = globalSingleton(
  "theokit-sdk.session.auto-compact-attempts",
  () => new Map<string, number>(),
);

/**
 * Fire auto-compaction when the threshold is crossed — at most ONE attempt per turn per agent
 * (anti-cascade: a failing summarizer or a non-reducing summary must not loop). Returns whether a
 * compaction actually happened. Failures WARN and leave the transcript untouched.
 */
export async function autoCompactIfNeeded(opts: {
  store: SessionStore;
  loc: CompactLocation;
  sessionId: string;
  usageTotal?: number | undefined;
  contextWindow?: number | undefined;
  turnCount: number;
  summarize: (messages: readonly CompressibleMessage[]) => Promise<string>;
}): Promise<boolean> {
  if (!shouldAutoCompact(opts)) return false;
  const key = `${opts.loc.cwd}::${opts.loc.agentId}`;
  if (autoCompactAttempts.get(key) === opts.turnCount) return false; // already attempted this turn
  autoCompactAttempts.set(key, opts.turnCount);
  try {
    await compactSessionTranscript({
      store: opts.store,
      loc: opts.loc,
      sessionId: opts.sessionId,
      trigger: "auto",
      summarize: opts.summarize,
    });
    return true;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    diag(`[theokit-sdk] auto-compaction failed (left transcript untouched): ${msg}\n`);
    return false;
  }
}
