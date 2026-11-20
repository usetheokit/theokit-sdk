/**
 * D204 — Eval execution engine. Orchestrates dataset materialization,
 * `Agent.batch` fanout, scorer application, aggregate computation, and
 * single-flight lifecycle.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";
import type { SDKAgent } from "../../types/agent.js";
import type { BatchOptions, BatchResult } from "../../types/batch.js";
import type {
  DatasetEntry,
  EvalAggregate,
  EvalHooks,
  EvalOptions,
  EvalPersistOptions,
  EvalRowResult,
  EvalRun,
  EvalRunOptions,
  NamedScorer,
  Score,
  ScoreContext,
  ScoredToolCall,
  Scorer,
} from "../../types/eval.js";
import { diag } from "../diagnostics.js";
import { appendJsonl, readJsonlIds } from "../persistence/jsonl.js";
import { getAgentFacade } from "../runtime/registry/agent-factory-registry.js";
import { collectToolCalls } from "../scorers/tool-calls.js";
import { clampScore, computeAggregate } from "./aggregate.js";
import { materializeDataset } from "./dataset-iter.js";
import { acquireSingleFlight, releaseSingleFlight } from "./single-flight.js";
import { startEvalRunSpan } from "./telemetry.js";
import { collapseTrials, expandForTrials } from "./trials.js";

/**
 * EC-4: every hook invocation is wrapped here. User code throwing in
 * `afterRow` / `beforeRun` / `afterRun` is caught + warned once to stderr;
 * the run continues.
 */
function safeHook(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // theokit#147 — through the interceptable channel. The allowlist entry that exempted this file
    // claimed the caller controls the destination; it does not, and an in-process `Eval` run under a
    // TUI corrupted its frame by exactly the mechanism the issue reports.
    diag(`[eval] hook threw (ignored): ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function isAgentInstance(value: unknown): value is SDKAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { send?: unknown }).send === "function" &&
    typeof (value as { agentId?: unknown }).agentId === "string"
  );
}

interface NormalizedScorer {
  name: string;
  score: Scorer;
}

function normalizeScorers(input: ReadonlyArray<Scorer | NamedScorer>): NormalizedScorer[] {
  return input.map((s, i) => {
    if (typeof s === "function") {
      return { name: `scorer-${i}`, score: s };
    }
    return { name: s.name, score: s.score };
  });
}

/**
 * M6-1 durable-persist sink. `isResumed` answers the pre-execution skip
 * question (success-only); `finalize` applies `classify` + per-row flush the
 * instant a row completes. When neither `persist` nor `classify` is set, both
 * are no-ops and behavior is byte-identical to the pre-M6 runner.
 */
interface RowSink {
  isResumed(entry: DatasetEntry, index: number): boolean;
  finalize(row: EvalRowResult): EvalRowResult;
}

/**
 * A row-shaped probe built from a dataset entry, used to compute `persist.key`
 * BEFORE the agent runs (so a resumed row is skipped without paying for it).
 * A well-behaved `key` reads only durable fields (`input` / `metadata`).
 */
function probeRow(entry: DatasetEntry, index: number): EvalRowResult {
  return {
    index,
    input: entry.input,
    output: "",
    ...(entry.expected !== undefined ? { expected: entry.expected } : {}),
    scores: [],
    meanScore: 0,
    durationMs: 0,
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  };
}

/** Success-only resume key-set: keys of persisted rows that completed without `error`. */
function computeDoneKeys(persist: EvalPersistOptions): Set<string> {
  if (persist.resume !== true) return new Set<string>();
  return readJsonlIds(persist.path, (parsed) =>
    parsed.error === undefined ? persist.key(parsed as unknown as EvalRowResult) : undefined,
  );
}

/** Append a row without ever aborting the batch on an I/O error (mirror swebench-batch.ts:206). */
function appendRowSafely(path: string, row: EvalRowResult): void {
  try {
    appendJsonl(path, row);
  } catch (err) {
    diag(
      `[eval] persist append failed (ignored): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function makeRowSink(
  persist: EvalPersistOptions | undefined,
  classify: ((row: EvalRowResult) => string) | undefined,
): RowSink {
  const doneKeys = persist !== undefined ? computeDoneKeys(persist) : new Set<string>();
  return {
    isResumed(entry, index) {
      if (persist === undefined || doneKeys.size === 0) return false;
      return doneKeys.has(persist.key(probeRow(entry, index)));
    },
    finalize(row) {
      const outcome = classify?.(row);
      const finalRow = outcome !== undefined ? { ...row, outcome } : row;
      if (persist !== undefined) appendRowSafely(persist.path, finalRow);
      return finalRow;
    },
  };
}

async function applyScorer(
  scorer: NormalizedScorer,
  output: string,
  expected: unknown,
  context: ScoreContext,
): Promise<{ name: string; score: number; reason?: string }> {
  let raw: Score;
  try {
    const result = scorer.score(output, expected, context);
    raw = result instanceof Promise ? await result : result;
  } catch (err) {
    return {
      name: scorer.name,
      score: 0,
      reason: `scorer_threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const clamped = clampScore(raw);
  return clamped.reason === undefined
    ? { name: scorer.name, score: clamped.score }
    : { name: scorer.name, score: clamped.score, reason: clamped.reason };
}

function rowFromBatchResult(
  entry: DatasetEntry,
  batchResult: BatchResult,
  scorerResults: ReadonlyArray<{ name: string; score: number; reason?: string }>,
  index: number,
): EvalRowResult {
  const meanScore =
    scorerResults.length === 0
      ? 0
      : scorerResults.reduce((acc, s) => acc + s.score, 0) / scorerResults.length;
  const baseFields = {
    index,
    input: entry.input,
    expected: entry.expected,
    durationMs: batchResult.durationMs ?? 0,
    scores: scorerResults,
    meanScore,
  };
  if (batchResult.ok === true) {
    return {
      ...baseFields,
      output: batchResult.result.result ?? "",
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    };
  }
  return {
    ...baseFields,
    output: "",
    error: batchResult.error.message,
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  };
}

/**
 * Resolve the agent factory for a given dataset entry, honoring D204's
 * three accepted shapes:
 *   - Agent instance → use as-is for every row (shared state).
 *   - AgentOptions → wrap into a per-row factory that builds + disposes.
 *   - (entry) => Agent → call to get the agent for THIS entry.
 *
 * Returns the `BatchOptions.agent`-shaped factory expected by `Agent.batch`.
 */
function makeAgentForBatch(
  spec: EvalOptions["agent"],
  _entries: ReadonlyArray<DatasetEntry>,
): BatchOptions {
  // BatchOptions extends AgentOptions; when caller provides an Agent instance,
  // we still need to pass SOMETHING to AgentOptions (model). For the instance
  // case we proxy through a degenerate options shape that we override via the
  // batch's internal agent-factory path — but the simplest correct thing is
  // to call agent.send() directly OUTSIDE batch in that case.
  if (isAgentInstance(spec) || typeof spec === "function") {
    // Both cases handled outside Agent.batch (see runEvalLoop).
    throw new Error("internal: makeAgentForBatch only handles AgentOptions");
  }
  return spec as BatchOptions;
}

/**
 * For Agent-instance OR factory-function shapes, we can't use Agent.batch
 * (which requires AgentOptions to create fresh agents). Run a hand-rolled
 * bounded loop instead.
 */
type AgentSpec = SDKAgent | ((entry: DatasetEntry) => SDKAgent | Promise<SDKAgent>);

/**
 * Everything a run of the dataset holds fixed, whichever strategy executes it.
 *
 * The two strategies below took the SAME seven-item list with one substitution — `spec: AgentSpec`
 * against `agentOptions: BatchOptions`, in the second position — which is precisely the axis
 * `runEval` switches on. Six of seven parameters were loop-invariant state, and `runManualSlot`
 * re-declared six of them again to vary one index.
 */
interface EvalRunContext {
  readonly entries: ReadonlyArray<DatasetEntry>;
  readonly scorers: ReadonlyArray<NormalizedScorer>;
  readonly concurrency: number;
  readonly signal: AbortSignal | undefined;
  readonly onRow: (row: EvalRowResult, index: number) => void;
  readonly sink: RowSink;
}

/** Run a single manual-path slot: skip if resumed, else execute + finalize + record. */
async function runManualSlot(
  ctx: EvalRunContext,
  spec: AgentSpec,
  idx: number,
  rows: EvalRowResult[],
): Promise<void> {
  const { entries, scorers, sink, onRow } = ctx;
  const entry = entries[idx];
  if (entry === undefined) return;
  if (sink.isResumed(entry, idx)) return; // M6-1: already persisted successfully
  const row = sink.finalize(await runOneEntry(spec, entry, idx, scorers));
  rows[idx] = row;
  onRow(row, idx);
}

/**
 * For Agent-instance OR factory-function shapes, we can't use Agent.batch
 * (which requires AgentOptions to create fresh agents). Run a hand-rolled
 * bounded loop instead.
 */
async function runRowsManually(ctx: EvalRunContext, spec: AgentSpec): Promise<EvalRowResult[]> {
  const { entries, concurrency, signal } = ctx;
  const rows: EvalRowResult[] = new Array(entries.length);
  const state = { cursor: 0 };

  const worker = async (): Promise<void> => {
    while (state.cursor < entries.length) {
      if (signal?.aborted === true) return;
      const idx = state.cursor;
      state.cursor += 1;
      await runManualSlot(ctx, spec, idx, rows);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, () => worker());
  await Promise.all(workers);
  return rows.filter((r): r is EvalRowResult => r !== undefined);
}

async function executeAgent(
  spec: AgentSpec,
  entry: DatasetEntry,
): Promise<{ output: string; errorMsg?: string; toolCalls: readonly ScoredToolCall[] }> {
  try {
    const agent = isAgentInstance(spec) ? spec : await spec(entry);
    const run = await agent.send(entry.input);
    const collecting = collectToolCalls(run);
    const result = await run.wait();
    const toolCalls = await collecting;
    if (result.status === "finished") return { output: result.result ?? "", toolCalls };
    return { output: "", errorMsg: result.error?.message ?? `run ${result.status}`, toolCalls };
  } catch (err) {
    return {
      output: "",
      errorMsg: err instanceof Error ? err.message : String(err),
      toolCalls: [],
    };
  }
}

function contextFor(entry: DatasetEntry, toolCalls: readonly ScoredToolCall[]): ScoreContext {
  return {
    input: entry.input,
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    toolCalls,
  };
}

async function runOneEntry(
  spec: AgentSpec,
  entry: DatasetEntry,
  idx: number,
  scorers: ReadonlyArray<NormalizedScorer>,
): Promise<EvalRowResult> {
  const t0 = Date.now();
  const { output, errorMsg, toolCalls } = await executeAgent(spec, entry);
  const durationMs = Date.now() - t0;
  const scoreEntries: Array<{ name: string; score: number; reason?: string }> = [];
  if (errorMsg === undefined) {
    for (const scorer of scorers) {
      scoreEntries.push(
        await applyScorer(scorer, output, entry.expected, contextFor(entry, toolCalls)),
      );
    }
  }
  const meanScore =
    scoreEntries.length === 0
      ? 0
      : scoreEntries.reduce((acc, s) => acc + s.score, 0) / scoreEntries.length;
  return {
    index: idx,
    input: entry.input,
    output,
    ...(entry.expected !== undefined ? { expected: entry.expected } : {}),
    scores: scoreEntries,
    meanScore: errorMsg === undefined ? meanScore : 0,
    durationMs,
    ...(errorMsg !== undefined ? { error: errorMsg } : {}),
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  };
}

/**
 * AgentOptions path: use Agent.batch for fanout, then apply scorers per result.
 */
async function scoreBatchOutput(
  br: BatchResult | undefined,
  entry: DatasetEntry,
  scorers: ReadonlyArray<NormalizedScorer>,
  collectors: ReadonlyMap<string, Promise<ScoredToolCall[]>>,
): Promise<Array<{ name: string; score: number; reason?: string }>> {
  const scoreEntries: Array<{ name: string; score: number; reason?: string }> = [];
  if (br?.ok !== true) return scoreEntries;
  const output = br.result?.result ?? "";
  const toolCalls = (await collectors.get(br.result.id)) ?? [];
  const context = contextFor(entry, toolCalls);
  for (const scorer of scorers) {
    scoreEntries.push(await applyScorer(scorer, output, entry.expected, context));
  }
  return scoreEntries;
}

/**
 * `Agent.batch` returns results without run handles, so the batch core runs here with a `create`
 * that records each run's tool calls under its run id (the id is also on the `RunResult`).
 */
async function batchWithToolCalls(
  inputs: string[],
  opts: BatchOptions,
  collectors: Map<string, Promise<ScoredToolCall[]>>,
): Promise<BatchResult[]> {
  const { batchImpl } = await import("../agent/batch.js");
  const facade = getAgentFacade();
  return batchImpl(inputs, opts, {
    create: async (agentOpts) => {
      const agent = await facade.create(agentOpts);
      const send = agent.send.bind(agent);
      agent.send = async (...args: Parameters<SDKAgent["send"]>) => {
        const run = await send(...args);
        collectors.set(run.id, collectToolCalls(run));
        return run;
      };
      return agent;
    },
  });
}

async function runRowsViaBatch(
  ctx: EvalRunContext,
  agentOptions: BatchOptions,
): Promise<EvalRowResult[]> {
  const { entries, scorers, concurrency, signal, onRow, sink } = ctx;
  // M6-1: resumed rows are filtered out BEFORE the batch so they cost nothing.
  const pending: Array<{ entry: DatasetEntry; index: number }> = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (sink.isResumed(entry, i)) continue;
    pending.push({ entry, index: i });
  }
  const batchOpts: BatchOptions = {
    ...agentOptions,
    concurrency,
    ...(signal !== undefined ? { signal } : {}),
  };
  const collectors = new Map<string, Promise<ScoredToolCall[]>>();
  const batchResults = await batchWithToolCalls(
    pending.map((p) => p.entry.input),
    batchOpts,
    collectors,
  );
  const rows: EvalRowResult[] = [];
  for (let i = 0; i < batchResults.length; i += 1) {
    const slot = pending[i];
    const br = batchResults[i];
    if (slot === undefined || br === undefined) continue;
    const scoreEntries = await scoreBatchOutput(br, slot.entry, scorers, collectors);
    const row = sink.finalize(rowFromBatchResult(slot.entry, br, scoreEntries, slot.index));
    rows.push(row);
    onRow(row, slot.index);
  }
  return rows;
}

export async function runEval(
  options: EvalOptions,
  runOpts: EvalRunOptions | undefined,
): Promise<EvalRun> {
  acquireSingleFlight(options.name);
  const id = randomUUID();
  const startedAt = Date.now();
  const entries = await materializeDataset(options.dataset);
  const materialized: DatasetEntry[] = entries.map((e) => ({ ...e }));
  // SE41: with trials > 1, run each entry N times (tagged), then collapse.
  const trials = options.trials ?? 1;
  const indexed: DatasetEntry[] = trials > 1 ? expandForTrials(materialized, trials) : materialized;
  const scorers = normalizeScorers(options.scorers);
  const concurrency = options.concurrency ?? 4;
  const signal = runOpts?.signal;
  // D206 — open `eval.run` span (no-op when OTel unavailable). MUST end in finally.
  const span = startEvalRunSpan({
    name: options.name,
    id,
    rows: entries.length,
    concurrency,
  });
  try {
    const hooks: EvalHooks | undefined = options.hooks;
    safeHook(() => hooks?.beforeRun?.({ name: options.name, totalEstimate: entries.length }));

    const onRow = (row: EvalRowResult, i: number): void => {
      safeHook(() => hooks?.afterRow?.(row, i));
    };
    // M6-1: durable per-row persist + resume + classify (no-op when unset).
    const sink = makeRowSink(runOpts?.persist, runOpts?.classify);

    const runCtx: EvalRunContext = { entries: indexed, scorers, concurrency, signal, onRow, sink };
    // The ONE axis the two strategies differ on: an Agent instance or factory cannot go through
    // `Agent.batch` (which needs `AgentOptions` to create fresh agents), so it takes the hand-rolled
    // bounded loop. Everything else about the run is the same context.
    const rows = await (isAgentInstance(options.agent) || typeof options.agent === "function"
      ? runRowsManually(
          runCtx,
          options.agent as SDKAgent | ((entry: DatasetEntry) => SDKAgent | Promise<SDKAgent>),
        )
      : runRowsViaBatch(runCtx, makeAgentForBatch(options.agent, indexed)));

    // SE41: collapse per-trial rows back to one row per dataset entry.
    const finalRows = trials > 1 ? collapseTrials(rows, trials) : rows;
    const aggregate: EvalAggregate = computeAggregate(finalRows);
    const endedAt = Date.now();
    const run: EvalRun = {
      id,
      name: options.name,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      aggregate,
      rows: finalRows,
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    };
    safeHook(() => hooks?.afterRun?.(run));
    // Annotate the span with final aggregate metrics (D206 / D211).
    span.setAttribute("eval.aggregate.meanScore", run.aggregate.meanScore);
    span.setAttribute("eval.aggregate.errorRows", run.aggregate.errorRows);
    span.setAttribute("eval.aggregate.durationMsP95", run.aggregate.durationMsP95);
    span.setAttribute("eval.aggregate.tokensInTotal", run.aggregate.tokensInTotal);
    return run;
  } finally {
    span.end();
    releaseSingleFlight(options.name);
  }
}
