/**
 * Owner: `internal/eval/` (5 of 8 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * Public type contract for `Eval.create / .run` and the `Scorers` namespace
 * (Adoption Roadmap #2; ADRs D202-D213).
 *
 * Consumers import these types via `@theokit/sdk` — they're re-exported
 * from the package barrel. Implementation lives in `eval.ts`, `scorers.ts`,
 * and `internal/eval/**`.
 *
 * @public
 */

import type { SandboxBackend } from "../sandbox/types.js";
import type { SDKAgent } from "./agent.js";

/** Inferred `Agent.create` options shape — avoid cycling through `AgentOptions` directly. */
export type EvalAgentOptions = Parameters<typeof import("../agent.js").Agent.create>[0];

/** A single dataset row — input prompt + optional reference + free-form metadata. */
export interface DatasetEntry {
  readonly input: string;
  readonly expected?: unknown;
  readonly metadata?: Record<string, unknown>;
}

/**
 * `Dataset` is either an array OR a factory returning a (sync or async)
 * iterable (D210). The runner normalizes both shapes into an
 * `AsyncIterable<DatasetEntry>` internally.
 */
export type Dataset =
  | ReadonlyArray<DatasetEntry>
  | (() => Iterable<DatasetEntry> | AsyncIterable<DatasetEntry>);

/** Outcome of a single scoring decision. `score` in [0, 1]; the runner clamps. */
export interface Score {
  readonly score: number;
  readonly reason?: string;
}

/** One tool call the run made, as a scorer sees it. */
export interface ScoredToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** The tool's result as text; absent when the call never completed. */
  readonly output?: string;
  readonly isError: boolean;
}

/** What the runner knows about the row beyond the final text. */
export interface ScoreContext {
  readonly input: string;
  readonly metadata?: Record<string, unknown>;
  /** In call order, across the whole run. */
  readonly toolCalls: readonly ScoredToolCall[];
}

/**
 * Scorer signature (D207). Returns `Score` synchronously OR via Promise —
 * the runner always awaits. The runner passes a {@link ScoreContext} as the
 * third argument; a scorer that takes fewer parameters is unaffected.
 */
export type Scorer = (
  output: string,
  expected?: unknown,
  context?: ScoreContext,
) => Score | Promise<Score>;

/** A named scorer — produced by every `Scorers.*` factory. */
export interface NamedScorer {
  readonly name: string;
  readonly score: Scorer;
}

/** Lifecycle hooks. Each fires inside a `safeHook` wrapper (EC-4); a throw never aborts the run. */
export interface EvalHooks {
  readonly beforeRun?: (info: { name: string; totalEstimate: number | undefined }) => void;
  readonly afterRow?: (row: EvalRowResult, index: number) => void;
  readonly afterRun?: (run: EvalRun) => void;
}

/** Public options for `Eval.create`. */
export interface EvalOptions {
  /**
   * Unique-per-process name for telemetry correlation + report titles.
   * Concurrent runs with the same name throw `EvalAlreadyRunningError` (D213).
   */
  readonly name: string;
  /** The dataset to evaluate. See {@link Dataset}. */
  readonly dataset: Dataset;
  /** At least one scorer. Plain `Scorer` is wrapped with an auto-name. */
  readonly scorers: ReadonlyArray<Scorer | NamedScorer>;
  /**
   * Agent to evaluate. Three accepted shapes:
   *  - `SDKAgent` instance — same agent used for every row (no state isolation).
   *  - `EvalAgentOptions` — a fresh agent is constructed per row (state isolation; default).
   *  - `(entry) => SDKAgent | Promise<SDKAgent>` — dynamic agent selection.
   */
  readonly agent:
    | SDKAgent
    | EvalAgentOptions
    | ((entry: DatasetEntry) => SDKAgent | Promise<SDKAgent>);
  /**
   * Row concurrency. Default 4 (matches `Agent.batch` D136). MUST be in
   * `[1, 64]` (EC-3 — 0 deadlocks the semaphore, Infinity DoSs the provider).
   */
  readonly concurrency?: number;
  /**
   * Repeat each dataset row `trials` times to smooth non-determinism (SE41).
   * Default 1 (no repeat; behavior byte-identical to a non-trialed run). MUST
   * be an integer in `[1, 100]`. With `trials > 1` the returned `EvalRun.rows`
   * still has ONE row per dataset entry — see {@link EvalRowResult.trialCount}
   * for the collapse semantics. Reserved metadata keys `__evalTrial` /
   * `__evalRowIndex` are attached to each per-trial persisted row.
   */
  readonly trials?: number;
  /** Optional metadata persisted to `EvalRun.metadata` (tags, env, version). */
  readonly metadata?: Record<string, unknown>;
  /** Optional progress / lifecycle hooks. */
  readonly hooks?: EvalHooks;
}

/** Per-row outcome. */
export interface EvalRowResult {
  readonly index: number;
  readonly input: string;
  readonly output: string;
  readonly expected?: unknown;
  readonly scores: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly reason?: string;
  }>;
  readonly meanScore: number;
  readonly durationMs: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * Free-form taxonomy label assigned by `EvalRunOptions.classify` (M6-1).
   * Persisted alongside the row when `persist` is set.
   */
  readonly outcome?: string;
  /**
   * How many trials produced this row (SE41). Present only when
   * `EvalOptions.trials > 1`: the row is a COLLAPSE of `trialCount` executions
   * of the same dataset entry — each scorer's `score` is the mean over the
   * trials (an errored trial contributes 0, a reliability signal), and
   * `durationMs` / `tokensIn` / `tokensOut` are summed. Absent ⇒ single run.
   */
  readonly trialCount?: number;
  /**
   * Captured code change (M6-4): the working-tree `git diff` an agent produced
   * and whether it reverse-applies cleanly. Produced by `captureArtifact`; the
   * caller attaches it to the row (the runner does not set it automatically).
   */
  readonly artifact?: {
    readonly diff: string;
    readonly applies: boolean;
  };
}

/**
 * Options for `Scorers.verifyGate` (M6-2) — grade a patch by running the
 * project's tests in a provisioned repo and reading the exit code.
 */
export interface VerifyGateOptions {
  /**
   * Sandbox the test command runs in (D2 — Local/Docker/E2B). Optional (V3-5):
   * defaults to a `LocalSandbox`. `verifyGate` always `cd`s to the explicit
   * `repoDir`, so the default's workdir is irrelevant here.
   */
  readonly sandbox?: SandboxBackend;
  /** Repo dir to run the tests from (typically `provisionRepo`'s `repoDir`). */
  readonly repoDir: string;
  /** SWE-bench tests that must flip to passing after the patch. */
  readonly failToPass: readonly string[];
  /** SWE-bench tests that must stay passing after the patch. */
  readonly passToPass: readonly string[];
  /**
   * REQUIRED — builds the shell command from the combined test list, e.g.
   * `(t) => "pytest " + t.join(" ")`. The builder OWNS shell-safety of the test
   * identifiers: the SDK runs the returned string in a shell, so a builder that
   * concatenates untrusted dataset test names without quoting is an injection
   * vector (the SDK deliberately ships NO unsafe default that would run bare
   * identifiers — see SECURITY note on `verifyGate`).
   */
  readonly command: (tests: readonly string[]) => string;
}

/** Per-scorer breakdown computed across all rows. */
export interface PerScorerStats {
  readonly mean: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/** Aggregate stats — the production-decision dashboard data (D211). */
export interface EvalAggregate {
  readonly meanScore: number;
  readonly medianScore: number;
  /** Ratio of rows where `meanScore >= 0.5`. */
  readonly passRatio: number;
  readonly perScorer: Record<string, PerScorerStats>;
  readonly totalRows: number;
  readonly errorRows: number;
  readonly durationMsP50: number;
  readonly durationMsP95: number;
  readonly tokensInTotal: number;
  readonly tokensOutTotal: number;
}

/** Final run result — plain serializable JSON (D209). */
export interface EvalRun {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly aggregate: EvalAggregate;
  readonly rows: ReadonlyArray<EvalRowResult>;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Crash-durable persistence for `eval.run(...)` (M6-1). Each completed row is
 * appended to `path` the instant it finishes (one `\n`-terminated JSON line),
 * so a crashed multi-hour run resumes without re-paying completed work.
 *
 * Single-process contract: `appendFileSync` serializes writes within one Node
 * process; do NOT point two concurrent processes at the same `path`.
 */
export interface EvalPersistOptions {
  /** JSONL output path. Parent directories are created on first append. */
  readonly path: string;
  /**
   * Stable identity of a row, used for resume. MUST be computed only from the
   * fields available at resume-probe time (`index` / `input` / `expected` /
   * `metadata`) — the type enforces this: at resume the key is computed from a
   * probe row BEFORE the agent runs, so `output` / `scores` / `meanScore` are
   * not yet known. Reading any non-durable field would silently break resume.
   */
  readonly key: (row: Pick<EvalRowResult, "index" | "input" | "expected" | "metadata">) => string;
  /**
   * When `true`, rows whose `key` already appears in `path` with a SUCCESSFUL
   * (no `error`) result are skipped — not re-executed and not re-emitted in
   * `EvalRun.rows`. Failed rows are always retried.
   */
  readonly resume?: boolean;
}

/**
 * Threshold contract for `assertEval(run, thresholds)` (SE41) — the CI gate.
 * Every field is optional; only the ones you set are checked. A run passes
 * iff EVERY set threshold is satisfied; otherwise `assertEval` throws
 * `EvalThresholdError` carrying the full list of failures.
 */
export interface EvalThresholds {
  /** `aggregate.meanScore` MUST be `>=` this. */
  readonly minMeanScore?: number;
  /** `aggregate.passRatio` (rows with meanScore >= 0.5) MUST be `>=` this. */
  readonly minPassRatio?: number;
  /** `errorRows / totalRows` MUST be `<=` this (0 rows ⇒ ratio 0). */
  readonly maxErrorRatio?: number;
  /**
   * Per-scorer floor on `aggregate.perScorer[name].mean`. A named scorer that
   * never ran (absent from `perScorer`) is itself a failure ("scorer not found").
   */
  readonly perScorer?: Readonly<Record<string, number>>;
}

/** One unmet threshold, surfaced on `EvalThresholdError.failures`. */
export interface EvalThresholdFailure {
  /** Stable metric id, e.g. `"meanScore"`, `"passRatio"`, `"perScorer.exact-match"`. */
  readonly metric: string;
  /** The floor (or ceiling, for `maxErrorRatio`) that was required. */
  readonly threshold: number;
  /** The observed value that violated the threshold (`NaN` when the scorer was absent). */
  readonly actual: number;
}

/** Per-call options for `eval.run(...)`. */
export interface EvalRunOptions {
  /** Cancels pending rows; in-flight rows complete (D140 pattern). */
  readonly signal?: AbortSignal;
  /** Durable, resumable per-row persistence (M6-1). Absent → no file is written. */
  readonly persist?: EvalPersistOptions;
  /**
   * Optional taxonomy classifier applied to each completed row; the result is
   * stored on `EvalRowResult.outcome` and persisted (M6-1).
   */
  readonly classify?: (row: EvalRowResult) => string;
}
