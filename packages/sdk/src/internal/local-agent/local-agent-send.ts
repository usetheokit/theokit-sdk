import { AgentDisposedError, ConfigurationError } from "../../errors.js";
import type { AgentOptions, ModelSelection } from "../../types/agent.js";
import type { Run, SDKUserMessage, SendOptions } from "../../types/run.js";
import type { MemoryToolSpec } from "../agent-loop/types.js";
import { anySignal } from "../concurrency/abort-utils.js";
import { diagFailure } from "../diagnostics.js";
import { emitRunEvent } from "../emit-run-event.js";
import type { PluginManager } from "../plugins/manager.js";
import {
  type CompletionCheckDeps,
  wrapRunWithCompletionCheck,
} from "../runtime/lifecycle/wrap-completion-check-run.js";
import type { MemoryProvider } from "../runtime/memory-glue/memory-provider.js";
import type { MemoryFact } from "../runtime/memory-glue/memory-store.js";
import { readMemoryFacts } from "../runtime/memory-glue/memory-store.js";
import { selectFactsForInjection } from "../runtime/memory-glue/select-facts.js";
import { normalizeModel } from "../runtime/model-selection.js";
import { runInputProcessors } from "../runtime/processors/run-processors.js";
import { createTripwireRun } from "../runtime/processors/tripwire-run.js";
import { wrapRunWithOutputProcessors } from "../runtime/processors/wrap-output-run.js";
import { safeCall } from "../runtime/system-prompt/safe-call.js";
import { appendSessionMessage, clearSession, getSessionMessages } from "../session/index.js";
import type { TelemetryHandle } from "../telemetry/tracer.js";
import { consumePending } from "./local-agent-invalidate.js";
import { applyPreUserSendHook, wrapRunWithPostReplyHook } from "./local-agent-memory-hooks.js";
import { persistMemoryFactIfWritePrompt } from "./local-agent-runtime-extensions.js";

/**
 * Inputs for the `executeSendLocked` helper extracted from LocalAgent.sendLocked.
 * @internal
 */
export interface SendLockedInputs {
  agentId: string;
  disposed: boolean;
  invalidationPending: { reason: string; at: number } | undefined;
  clearInvalidation: () => void;
  reload: () => Promise<void>;
  // SE8 — receives an already-NORMALIZED ModelSelection (the string shorthand is
  // normalized at the send boundary), decoupled from the public AgentOptions type.
  applyModelOverride: (model: ModelSelection | undefined) => void;
  options: AgentOptions;
  pluginManagerCode: PluginManager;
  defaultMemoryProviderForLoop: ReturnType<
    typeof import("./local-agent-memory-provider.js").createLocalAgentMemoryProvider
  >;
  workspaceCwd: string;
  telemetry: TelemetryHandle;
  lifecycleAbortController: AbortController;
  runPreHook: (userText: string) => Promise<void>;
  resolveSystemPromptForSend: (
    userText: string,
    options: SendOptions,
    memoryFacts: ReadonlyArray<MemoryFact>,
  ) => Promise<string | undefined>;
  assembleSystemPromptForSend: (request: SendAssemblyRequest) => Promise<string | undefined>;
  dispatchRun: (args: DispatchRunArgs) => Promise<Run>;
}

/**
 * What one send needs assembled into a system prompt. The port took the same five values
 * positionally, so the binding in `LocalAgent` read `(ut, bp, mf, ams, cp) => …` — five
 * abbreviations relaying into a six-argument helper call.
 */
export interface SendAssemblyRequest {
  readonly userText: string;
  readonly baseSystemPrompt: string | undefined;
  readonly memoryFacts: ReadonlyArray<MemoryFact>;
  readonly activeMemorySummary: string | undefined;
  readonly contextPaths: readonly string[] | undefined;
}

/**
 * The arguments of one dispatch, as a record.
 *
 * They were seven positional parameters declared TWICE — here and on `LocalAgent.dispatchRun` — kept
 * in step by hand behind a `jscpd:ignore` pair, and relayed by
 * `(msg, o, sp, mf, pm, mt, mp) => this.dispatchRun(msg, o, sp, mf, pm, mt, mp)`. The abbreviations
 * were not carelessness: the arrow is one line because of the 400-LoC file budget, and a one-line
 * arrow has no room for real names. `pm` there is `priorMessages` while `pm` in a sibling lambda two
 * declarations up is `pluginManager`.
 *
 * One named type: the relay becomes `(args) => this.dispatchRun(args)`, which fits on one line
 * without abbreviating anything, and the duplicate declaration — with the suppression that hid it —
 * is gone.
 */
export interface DispatchRunArgs {
  readonly message: string | SDKUserMessage;
  readonly options: SendOptions;
  readonly systemPrompt: string | undefined;
  readonly memoryFacts: ReadonlyArray<MemoryFact>;
  readonly priorMessages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  readonly memoryTools: ReadonlyArray<MemoryToolSpec> | undefined;
  readonly memoryProviderOverride?: MemoryProvider | undefined;
}

/**
 * SE24 — run the input guardrail processors on the raw user text. Returns a
 * terminal `tripwireRun` when a processor blocked, else the (possibly rewritten)
 * `userText` + `effectiveMessage` to feed the rest of the send.
 */
async function applyInputProcessors(
  inputs: SendLockedInputs,
  message: string | SDKUserMessage,
  rawUserText: string,
  options: SendOptions,
  sendModel: ModelSelection | undefined,
): Promise<{ tripwireRun: Run } | { userText: string; effectiveMessage: string | SDKUserMessage }> {
  const processors = inputs.options.inputProcessors;
  if (processors === undefined || processors.length === 0) {
    return { userText: rawUserText, effectiveMessage: message };
  }
  const res = await runInputProcessors(processors, rawUserText, inputs.agentId);
  if (res.kind === "tripwire") {
    emitRunEvent(options.onRunEvent, {
      type: "tripwire",
      reason: res.tripwire.reason,
      processorId: res.tripwire.processorId,
    });
    return {
      tripwireRun: createTripwireRun({
        agentId: inputs.agentId,
        tripwire: res.tripwire,
        model: sendModel,
      }),
    };
  }
  const effectiveMessage =
    typeof message === "string" ? res.value : { ...message, text: res.value };
  return { userText: res.value, effectiveMessage };
}

const lastSendAt = new Map<string, number>();

/** Clears the agent's conversation when it has been idle longer than `minutes`. */
function applyIdleReset(agentId: string, minutes: number | undefined): void {
  const now = Date.now();
  const previous = lastSendAt.get(agentId);
  lastSendAt.set(agentId, now);
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return;
  if (previous !== undefined && now - previous > minutes * 60_000) clearSession(agentId);
}

/**
 * Core send logic extracted from `LocalAgent.sendLocked` to reduce
 * the LocalAgent class LoC (G8 budget). All dependencies are injected
 * via the `inputs` parameter.
 *
 * @internal
 */
export async function executeSendLocked(
  inputs: SendLockedInputs,
  message: string | SDKUserMessage,
  options: SendOptions,
): Promise<Run> {
  if (inputs.disposed) throw new AgentDisposedError(inputs.agentId);
  await consumePending(
    inputs.agentId,
    inputs.invalidationPending,
    inputs.clearInvalidation,
    inputs.reload,
  );
  // SE8 — normalize a bare-string send-model override to `{ id }`.
  const sendModel = normalizeModel(options.model);
  inputs.applyModelOverride(sendModel);
  const rawUserText = typeof message === "string" ? message : message.text;

  // SE24 — input guardrail processors run FIRST, before any side effect; a
  // `block` short-circuits to a tripwire run, a `rewrite` flows downstream.
  const gated = await applyInputProcessors(inputs, message, rawUserText, options, sendModel);
  if ("tripwireRun" in gated) return gated.tripwireRun;
  const { userText, effectiveMessage } = gated;

  applyIdleReset(inputs.agentId, inputs.options.sessionIdleResetMinutes);

  if (inputs.options.onBeforeSend !== undefined) {
    await inputs.options.onBeforeSend({
      conversationId: inputs.agentId,
      previousMessageCount: getSessionMessages(inputs.agentId).length,
    });
  }
  await inputs.runPreHook(userText);

  const adaptedMessage = await applyPreUserSendHook({
    pluginManager: inputs.pluginManagerCode,
    agentId: inputs.agentId,
    options: inputs.options,
    original: effectiveMessage,
    userText,
    sendOptions: options,
  });

  const priorMessages = [...getSessionMessages(inputs.agentId)];
  appendSessionMessage(inputs.agentId, { role: "user", text: userText });

  // Where memory lives is `memory.directory`'s answer and nobody else's. It used to be
  // `local.sessionDir`'s — the option that names the TRANSCRIPT home — so one option answered two
  // questions and only the writer heard the second answer (#463).
  await persistMemoryFactIfWritePrompt(inputs.workspaceCwd, inputs.options.memory, userText);
  const memoryFacts = await readMemoryForSend(inputs.workspaceCwd, inputs.options.memory, userText);
  // The MemoryProvider port is the ONLY memory path now (kernel flip, 2026-09-02). Both of this
  // send's memory jobs happen inside the agent loop: the tool catalog comes from
  // `provider.buildTools()` and the recall summary from `provider.runActivePass()`, so nothing is
  // resolved here and the two `undefined`s below say so rather than hiding it.
  //
  // A consumer-supplied provider always wins; otherwise the auto-installed adapter over
  // `LocalAgentMemory` runs, which is what the legacy branch used to do inline.
  const memoryTools = undefined;
  const activeMemorySummary = undefined;
  const effectiveMemoryProvider =
    inputs.options.memoryProvider ?? inputs.defaultMemoryProviderForLoop;
  const baseSystemPrompt = await inputs.resolveSystemPromptForSend(userText, options, memoryFacts);
  const assembledSystemPrompt = await inputs.assembleSystemPromptForSend({
    userText,
    baseSystemPrompt,
    memoryFacts,
    activeMemorySummary,
    contextPaths: options.contextPaths,
  });
  const composedOptions: SendOptions = {
    ...options,
    signal: anySignal([options.signal, inputs.lifecycleAbortController.signal]),
  };
  const run = await inputs.dispatchRun({
    message: adaptedMessage,
    options: composedOptions,
    systemPrompt: assembledSystemPrompt,
    memoryFacts,
    priorMessages,
    memoryTools,
    memoryProviderOverride: effectiveMemoryProvider,
  });
  // SE24 — output processors wrap INNER (they redact/block the model text) so the
  // post_assistant_reply memory hook observes the FINAL (processed) reply.
  const outputProcessors = inputs.options.outputProcessors;
  const processedRun =
    outputProcessors !== undefined && outputProcessors.length > 0
      ? wrapRunWithOutputProcessors({
          run,
          processors: outputProcessors,
          agentId: inputs.agentId,
          onRunEvent: options.onRunEvent,
        })
      : run;
  const hookedRun = wrapRunWithPostReplyHook({
    pluginManager: inputs.pluginManagerCode,
    agentId: inputs.agentId,
    options: inputs.options,
    run: processedRun,
    userText,
  });
  // SE34 — outermost wrap: judge the FINAL reply against the per-send completion
  // criterion (opt-in). Absent `completionCheck` ⇒ returns `hookedRun` unchanged.
  return wrapRunWithCompletionCheck({
    run: hookedRun,
    completionCheck: options.completionCheck,
    onRunEvent: options.onRunEvent,
    deps: buildCompletionCheckDeps(),
  });
}

/** Resolve the LLM-judge dep from the DI registry (mirrors runUntil's judge wiring). */
function buildCompletionCheckDeps(): CompletionCheckDeps {
  return {
    judge: async (ctx, opts) => {
      const { judgeCallImpl } = await import("../judge/judge-call.js");
      const { getAgentFacade } = await import("../runtime/registry/agent-factory-registry.js");
      return judgeCallImpl(ctx, opts, { create: getAgentFacade().create });
    },
  };
}

/**
 * Configurations already reported, so the refusal is said once rather than on every turn (#474).
 *
 * Per PROCESS and keyed by the configuration itself, not per agent: two agents built from the same
 * bad `directory` would otherwise each shout the same sentence, and the second one tells the reader
 * nothing the first did not. The set's size is the number of DISTINCT misconfigurations a process
 * holds, which is one in every case anybody has, and it never grows with turns.
 *
 * A warning that arrives every turn is a warning somebody turns off — the criterion already applied
 * to the near-miss diagnostic in #462.
 */
const reportedRefusedDirectories = new Set<string>();

function reportRefusedMemoryDirectoryOnce(
  workspaceCwd: string,
  directory: string | undefined,
  message: string,
): void {
  const key = `${workspaceCwd}\u0000${directory ?? ""}`;
  if (reportedRefusedDirectories.has(key)) return;
  reportedRefusedDirectories.add(key);
  diagFailure(
    `[theokit-sdk] memory is enabled but its directory was refused, so recall is empty on every ` +
      `turn and nothing is stored: ${message}`,
  );
}

function readMemoryForSend(
  workspaceCwd: string,
  memoryConfig: AgentOptions["memory"],
  query?: string,
): Promise<MemoryFact[]> {
  if (memoryConfig?.enabled !== true) return Promise.resolve([]);
  // Rank and cut before the facts reach the prompt. Without the cut the injected block tracked
  // the store (r = 0.958 across 99 real stores, past the session budget at 16 facts); without
  // the QUERY the cut was recency-only, and a live 25-fact run showed the answering fact
  // dropped for being old rather than irrelevant. Both halves are needed: one bounds the cost,
  // the other decides what survives.
  return safeCall(
    async () => {
      try {
        return selectFactsForInjection(await readMemoryFacts(workspaceCwd, memoryConfig), {
          ...(query === undefined ? {} : { query }),
        });
      } catch (cause) {
        // A REFUSED CONFIGURATION is not a read that went wrong; it is a read that will never go
        // right (#474). `safeCall` is correct for the case it was added for — a corrupt memory file
        // must not abort the turn (EC-4) — and it reports on `diag`, which the host may never read.
        // For a transient failure that is the right trade. A `ConfigurationError` from the resolver
        // repeats on EVERY turn, forever, and is fixable in one line by the person being kept in
        // the dark, so it goes on the channel a failure cannot be dropped from.
        //
        // The narrowing is DEFENSIVE, not load-bearing, and saying so is the point: today
        // `resolveMemoryRoot` is the only thing under `readMemoryFacts` that throws — both readers
        // swallow their own I/O errors and return `[]` (`markdown-store.ts:139-163`), so no test
        // can distinguish this line from `catch (cause)`. It stays because the message below is a
        // claim about CONFIGURATION; a future throw of another kind would inherit a sentence that
        // is false about it, on the one channel a host cannot silence.
        if (!(cause instanceof ConfigurationError)) throw cause;
        reportRefusedMemoryDirectoryOnce(workspaceCwd, memoryConfig?.directory, cause.message);
        return [];
      }
    },
    [],
    "memory read",
  );
}
