import {
  CONTEXT_WINDOW_FLOOR,
  CONTEXT_WINDOW_MARGIN,
  type EffectiveContextWindow,
  resolveEffectiveContextWindow,
} from "../../../compaction.js";
import type { MemorySettings } from "../../../types/agent.js";
import type { Run } from "../../../types/run.js";
import type { RunEventSink } from "../../../types/run-events.js";
import type { SessionStore } from "../../../types/session-store.js";
import { diag } from "../../diagnostics.js";
import { emitRunEvent } from "../../emit-run-event.js";
import { resolveMemoryRoot } from "../../memory/storage/memory-root.js";
import { writeSessionSummary } from "../../memory/storage/session-summary-writer.js";
import { getCatalogModelInfo } from "../../providers/catalog-loader.js";
import { buildDefaultSummarizer } from "../../session/compact-session.js";
import {
  appendSessionMessage,
  flushSessionWrites,
  persistTurnToTranscript,
} from "../../session/index.js";
import type { HooksExecutor } from "../hooks/hooks-executor.js";
import type { MemoryProvider } from "../memory-glue/memory-provider.js";
import { buildContextBudgetEvent } from "./context-budget-event.js";
import { readRunResolving } from "./throw-on-error-run.js";

/**
 * Inputs for {@link runPostRunLifecycle}. Bundled into a single record so the
 * caller (LocalAgent.send) doesn't carry a long positional argument list.
 *
 * SE41 — the `sessionStore` persists the native records (FS default or an injected
 * external store); `model` is stamped into the assistant records.
 *
 * @internal
 */
export interface PostRunLifecycleInputs {
  run: Run;
  userText: string;
  agentId: string;
  workspaceCwd: string;
  /** SE41 — the session record store (FS default, or an injected external store). */
  sessionStore: SessionStore;
  /** SE40 — model id stamped into the assistant records. */
  model: string;
  /**
   * M94 — window declared on the agent definition, in tokens.
   *
   * Forwarded as `override` to the resolver. It exists because a model with no catalog entry
   * (OpenRouter) stayed pinned to the 128k floor despite having 400k — compacting ~3x more than
   * needs it. The catalog clamp still protects against an inflated value.
   */
  contextWindow?: number | undefined;
  /** M50 — provider key for the auto-compaction summarizer (absent ⇒ env-resolved by the router). */
  apiKey?: string;
  /** SE2 — surface a `compact_boundary` RunEvent when a persistence-side compaction fires. */
  onRunEvent?: RunEventSink;
  hooksExecutor: HooksExecutor;
  /**
   * SDK 2.0 Phase 1 physical Stage 3 prep — iter 27 (refined iter 28):
   * optional port-based session-summary recorder. When supplied AND the
   * provider implements `recordSessionSummary`, the kernel delegates
   * the write through the port. When absent, falls back to the
   * legacy direct `writeSessionSummary` import (current behavior).
   *
   * STATELESS — no handle param needed (post-run-lifecycle runs AFTER
   * runAgentLoop disposes the per-run handle). `cwd` lives on the
   * args passed to the impl.
   */
  memoryProvider?: MemoryProvider;
  /**
   * The agent's `AgentOptions.memory`, read for one decision only: whether this run may write a
   * session transcript to the workspace. See {@link sessionTranscriptAllowed}.
   */
  memory?: MemorySettings | undefined;
}

/**
 * Whether a finished run may write its transcript to `<cwd>/.theokit/memory/sessions/<runId>.md`.
 *
 * usetheokit/theokit-sdk#382 — it could not previously be stopped. An agent built with
 * `memory: { enabled: false }` still had the full user prompt and assistant reply written into the
 * consumer's working directory on the first finished turn, which in a git repository is someone
 * else's repository. Every other memory surface already reads `enabled` (`ensureTools`,
 * `persistMemoryFactIfWritePrompt`, `readMemoryForSend` all return early on `enabled !== true`);
 * this write was the one that did not, so "memory is off" was not true of the subsystem as a whole.
 *
 * THE TEST IS `=== false`, NOT `!== true`, AND THE ASYMMETRY IS DELIBERATE. The rest of the memory
 * subsystem is off unless switched on; this write has been on since ADR D20 for every agent that
 * never mentioned `memory` at all, and it is what `memory_search({ corpus: "sessions" })` reads
 * once someone does switch memory on. Treating an absent config as off would silently empty the
 * sessions corpus for consumers who never asked for anything to change — a behaviour change billed
 * to people who did not opt into it. Writing `enabled: false` IS the opt-in, and it is the exact
 * request the defect report made. Leaving `memory` unset keeps the pre-#382 behaviour, which is
 * documented on {@link import("../../../types/agent.js").LocalOptions}.
 *
 * @internal
 */
export function sessionTranscriptAllowed(memory: MemorySettings | undefined): boolean {
  return memory?.enabled !== false;
}

/**
 * Resolves the window to budget for a run — the point where the declared window meets the catalog.
 *
 * It exists as its own function because the WIRING is what was broken: `resolveEffectiveContextWindow`
 * has accepted `override` since M77 and the only call site never passed it. A pure function makes that
 * forwarding testable without rebuilding half the runtime — a mutant that stops forwarding fails.
 *
 * A non-positive `contextWindow` is ignored: as an override it would produce a budget that triggers
 * compaction every turn, which is worse than the conservative floor.
 *
 * @internal
 */
export function resolveWindowForRun(
  model: string,
  contextWindow: number | undefined,
): EffectiveContextWindow {
  const override = contextWindow !== undefined && contextWindow > 0 ? contextWindow : undefined;
  return resolveEffectiveContextWindow({
    ...(override !== undefined ? { override } : {}),
    catalog: getCatalogModelInfo(model)?.limit?.context,
    margin: CONTEXT_WINDOW_MARGIN,
    floor: CONTEXT_WINDOW_FLOOR,
  });
}

/**
 * Post-run side effects executed inside the per-agent send mutex (ADR D19):
 *
 *  1. Persist the assistant turn to the per-agent JSONL (ADR D18).
 *  2. On status=finished, write a session-summary markdown for the
 *     `corpus="sessions"` memory_search index (ADR D20).
 *  3. Fire the `postRun` hook with the resolved status.
 *  4. Flush pending session writes so dispose() never races the writer.
 *
 * Errors are swallowed at the call site so `agent.send()` callers observe
 * failures through their own `run.wait()` / `stream()` surfaces. Mutex release
 * is guaranteed via the final `flushSessionWrites` even on the cancelled path.
 *
 * Extracted from LocalAgent to keep that class under the G8 LoC budget.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: lifecycle orchestrator dispatches across multiple subsystems
export async function runPostRunLifecycle(inputs: PostRunLifecycleInputs): Promise<void> {
  const {
    run,
    userText,
    agentId,
    workspaceCwd,
    sessionStore,
    model,
    contextWindow,
    onRunEvent,
    hooksExecutor,
    memoryProvider,
  } = inputs;
  let result: Awaited<ReturnType<Run["wait"]>>;
  try {
    result = await readRunResolving(run);
  } catch {
    // M93 — persists what the turn HAS ALREADY PRODUCED before leaving.
    //
    // The `flushSessionWrites` below has always been here, and always drained an **empty** set:
    // `persistTurnToTranscript` is only called later in this function — the **only** caller in the
    // repository — after this `return`. A 429 after eight tool calls destroyed the whole turn
    // leaving nothing on disk, and combined with the absent retry on the single-key path (also
    // closed in M93) the loss was total.
    //
    // Persists the **partial**, without reconstructing: a turn that failed in `run.wait()` has real history
    // — user + completed tool calls. Discarding it is the loss; inventing the rest would be worse than the loss.
    // The inner `catch` exists because a write failure must not mask the turn's error, which is what
    // the caller is waiting on (`error-handling.md`: cleanup does not propagate over the original error).
    try {
      const partial = await safeConversation(run);
      if (partial !== undefined) {
        persistTurnToTranscript(sessionStore, { cwd: workspaceCwd, agentId, model }, agentId, {
          userText,
          conversation: partial,
        });
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      diag(`[theokit-sdk] partial transcript write failed (${agentId}): ${msg}\n`);
    }
    // Caller observes failures via their own run.wait()/stream(); the
    // mutex still releases via the flushes below.
    await flushSessionWrites();
    return;
  }

  if (result.result !== undefined) {
    // In-memory cache: seed `priorMessages` for the NEXT send.
    appendSessionMessage(agentId, { role: "assistant", text: result.result });
  }

  // SE40 — persist the WHOLE turn (user + assistant + tool blocks) to the native
  // Claude-shaped transcript, once per send, from the rich `run.conversation()` view.
  // SE41 — through the session store (FS default or injected external store).
  const conversation = await safeConversation(run);
  // M50 — size-driven auto-compaction rides the SAME persistence chain: real usage from the run's
  // Completed (Codex `last_token_usage.total_tokens` analog) vs the model's context window. The
  // summarizer is the compression subsystem's aux-LLM via `buildDefaultSummarizer`.
  //
  // M77 — this used to read the catalog directly and, when the model was absent, leave the window
  // `undefined` so the trigger never fired. The comment here called that "fail-safe"; it was the
  // opposite. Not compacting when the window is unknown lets the conversation grow until the
  // PROVIDER rejects it — fail-OPEN, and silent. It now resolves to a floor and says so, so the
  // budget degrades instead of disappearing.
  const resolvedWindow = resolveWindowForRun(model, contextWindow);
  const effectiveWindow = resolvedWindow.window;
  const budgetEvent = buildContextBudgetEvent(model, resolvedWindow);
  if (budgetEvent !== undefined && onRunEvent !== undefined) {
    emitRunEvent(onRunEvent, budgetEvent);
  }
  // M50 review F3 — Codex uses the LAST response's usage as the active-context proxy; the aggregate
  // sums every round (each re-sends the whole context) and fires the trigger prematurely on
  // multi-round agentic turns. Prefer the last request's breakdown when available.
  const lastRequestUsage = result.usage?.requests?.at(-1)?.totalTokens;
  const usageForTrigger = lastRequestUsage ?? result.usage?.totalTokens;
  persistTurnToTranscript(
    sessionStore,
    { cwd: workspaceCwd, agentId, model },
    agentId,
    {
      userText,
      conversation,
      autoCompact: {
        usageTotal: usageForTrigger,
        // The EFFECTIVE window (after override, clamp and margin) — not the declared one. Swapping for
        // `contextWindow` here would budget against a number the clamp already rejected.
        contextWindow: effectiveWindow,
        summarize: buildDefaultSummarizer({
          agentModel: model,
          ...(inputs.apiKey !== undefined ? { apiKey: inputs.apiKey } : {}),
        }),
      },
    },
    onRunEvent !== undefined
      ? () => emitRunEvent(onRunEvent, { type: "compact_boundary", trigger: "auto" })
      : undefined,
  );

  // ADR D20 + EC-9: only finished runs feed the corpus="sessions" index.
  // usetheokit/theokit-sdk#382: and only when the agent has not disabled memory. The gate sits here
  // rather than inside `writeSessionSummary` so BOTH writers — the legacy direct call and the
  // `MemoryProvider.recordSessionSummary` port below — are covered by one decision; gating the
  // legacy writer alone would leave the port path writing under `THEOKIT_PORT_MEMORY_PATH=1`.
  if (
    result.status === "finished" &&
    result.result !== undefined &&
    sessionTranscriptAllowed(inputs.memory)
  ) {
    const summaryArgs = {
      cwd: workspaceCwd,
      // Resolved once, here, and handed to both writers. Recomputing it inside either one is how
      // the summary ended up in a directory the indexer never scanned (#463).
      memoryRoot: resolveMemoryRoot(workspaceCwd, inputs.memory),
      runId: result.id,
      agentId,
      userText,
      assistantText: result.result,
      status: "finished" as const,
      at: Date.now(),
    };
    try {
      // SDK 2.0 Phase 1 physical Stage 3 prep — iter 27 (refined iter 28):
      // prefer the STATELESS port-based `provider.recordSessionSummary`
      // when defined. Falls back to the direct `writeSessionSummary`
      // import otherwise (legacy behavior). Both paths handle the
      // markdown write + disk persistence; the difference is WHERE the
      // impl lives. Stateless = no handle needed (post-run-lifecycle
      // runs AFTER runAgentLoop disposed the per-run handle).
      if (memoryProvider?.recordSessionSummary !== undefined) {
        await memoryProvider.recordSessionSummary(summaryArgs);
      } else {
        await writeSessionSummary(summaryArgs);
      }
      // EC-3 used to be satisfied here by `memoryGlue.syncIfReady()`, so the next
      // `memory_search({corpus:"sessions"})` would see the summary just written. The agent loop
      // fires `provider.sync()` after a finished run, and since the kernel flip that is the only
      // path — calling both was a double sync, which is why the call was gated on the env var
      // rather than unconditional. The gate is gone with the flag; so is the call it guarded.
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      diag(`[theokit-sdk] session summary write failed (${result.id}): ${message}\n`);
    }
  }

  await hooksExecutor.run({
    event: "postRun",
    output: {
      status: result.status,
      ...(result.result !== undefined ? { result: result.result } : {}),
    },
    agentId,
    runId: result.id,
  });
  await flushSessionWrites();
}

/**
 * Read the rich per-turn conversation view for transcript persistence. Best-effort:
 * a run without `conversation()` (or one that throws) yields `[]` so persistence
 * degrades to the user turn only rather than crashing the post-run lifecycle.
 */
async function safeConversation(run: Run): Promise<Awaited<ReturnType<Run["conversation"]>>> {
  try {
    return await run.conversation();
  } catch (cause) {
    // The `[]` fallback stays — degrading to the user turn beats crashing the post-run lifecycle,
    // which is what the docblock above promises. What was inconsistent is the silence: the two other
    // failure paths in this same file (partial transcript write, session summary write) both diag
    // the cause, so the file had already decided persistence failures deserve a diagnostic. This one
    // silently TRUNCATES what gets persisted — the turn is written with the user message and no
    // assistant or tool content — which is the least visible of the three and was the only quiet one.
    const msg = cause instanceof Error ? cause.message : String(cause);
    diag(`[theokit-sdk] conversation() failed; persisting the user turn only: ${msg}\n`);
    return [];
  }
}
