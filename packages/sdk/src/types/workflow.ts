/**
 * Owner: `internal/workflow/` (15 of 19 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * Public type contract for `Workflow.create / .run / .resume` (Adoption
 * Roadmap #5; ADRs D230-D248).
 *
 * Step types form a discriminated union by `kind`. Helper factory functions
 * (`fn()`, `agentStep()`) live in `workflow.ts` and hide the discriminator
 * from end users.
 *
 * @public
 */

import type { ZodType } from "zod";

import type { SDKAgent } from "./agent.js";
import type { MessageOrigin } from "./run.js";

/* ─── Step discriminated union (D232) ─── */

/**
 * Any node of a committed workflow, discriminated by `kind`.
 *
 * Build these with the helpers rather than by hand: `fn()` and `agentStep()` set the discriminator,
 * validate the id, and parse the retry policy at construction — where a mistake is cheap — while the
 * builder methods `.parallel()`, `.branch()`, `.foreach()`, `.dowhile()`, `.sleep()` and `.suspend()`
 * cover the remaining variants and mint a positional default id (`parallel_0`, `branch_1`, ...) when
 * you do not pass one.
 *
 * Every id, nested ones included, must match `^[a-z0-9][a-z0-9_-]*$` case-insensitively and be at
 * most 64 characters, and must be unique across the whole workflow. `.commit()` walks the tree —
 * parallel branches, branch predicates, the fallback, and the inner step of a `foreach`/`dowhile` —
 * and throws {@link WorkflowDuplicateStepIdError} on the second occurrence.
 */
export type Step =
  | FnStep
  | AgentStep
  | ParallelStep
  | BranchStep
  | ForeachStep
  | DowhileStep
  | SleepStep
  | SuspendStep;

/** A pure function step. */
export interface FnStep {
  readonly kind: "fn";
  readonly id: string;
  readonly fn: (input: unknown, ctx: StepContext) => Promise<unknown> | unknown;
  readonly inputSchema?: ZodType;
  readonly outputSchema?: ZodType;
  readonly retry?: RetryPolicy;
  /**
   * @deprecated NOT IMPLEMENTED. Setting this does not enable saga rollback — it arms
   * `WorkflowCompensateNotImplementedError`, so the step FAILS at run time and the message tells you
   * to remove it. A field whose only effect is to make the step fail is worse than an absent field,
   * because the type invites it and the cost is discovered in production.
   *
   * Kept rather than removed because `FnStep` is published and dropping a member is a major-version
   * decision. The deprecation is the part that reaches a caller at the point of use: an editor
   * strikes it through, which the D238 comment that stood here ("slot reserved") did not.
   */
  readonly compensate?: (input: unknown, output: unknown, error: Error) => Promise<void> | void;
}

/** An agent.send-driven step. */
export interface AgentStep {
  readonly kind: "agent";
  readonly id: string;
  readonly agent: SDKAgent;
  readonly promptTemplate: string | ((input: unknown) => string);
  readonly retry?: RetryPolicy;
  /**
   * SE3 — provenance stamped onto this step's `agent.send()` (forwarded to
   * `RunResult.origin`). Squad sets `{ kind: "peer", from: "agent-<i-1>" }` on
   * every step after the first so a peer-driven turn is attributable.
   */
  readonly origin?: MessageOrigin;
}

/** N concurrent branches, each its own mini-step-list. */
export interface ParallelStep {
  readonly kind: "parallel";
  readonly id: string;
  readonly branches: ReadonlyArray<ReadonlyArray<Step>>;
  readonly concurrency?: number;
  readonly errorPolicy?: "fail-fast" | "collect";
}

/** First-match-wins predicates + optional fallback. */
export interface BranchStep {
  readonly kind: "branch";
  readonly id: string;
  readonly predicates: ReadonlyArray<
    readonly [(input: unknown) => boolean | Promise<boolean>, ReadonlyArray<Step>]
  >;
  readonly fallback?: ReadonlyArray<Step>;
}

/** Map a step over an upstream array output. */
export interface ForeachStep {
  readonly kind: "foreach";
  readonly id: string;
  /** ID of an upstream top-level step whose output is iterable. */
  readonly iterableFrom: string;
  readonly step: Step;
  readonly concurrency?: number;
}

/** Loop a step until condFn returns false. */
export interface DowhileStep {
  readonly kind: "dowhile";
  readonly id: string;
  readonly step: Step;
  readonly condFn: (output: unknown, iteration: number) => boolean | Promise<boolean>;
  readonly maxIterations?: number;
}

/** Pause for a fixed duration. */
export interface SleepStep {
  readonly kind: "sleep";
  readonly id: string;
  readonly durationMs: number;
}

/** Standalone explicit suspend point. */
export interface SuspendStep {
  readonly kind: "suspend";
  readonly id: string;
  readonly payloadSchema?: ZodType;
}

/* ─── Reflection (theokit#161) ─── */

/**
 * theokit#161 — one step of a workflow, as a reflection surface sees it.
 *
 * `id` and `kind` are the only fields every step variant shares, and they are what a reflection
 * endpoint renders. Everything else a step carries is an executable — a predicate, a condition, an
 * agent, a prompt template — which cannot cross a process boundary and means nothing to a caller
 * enumerating shape.
 *
 * @public
 */
export interface WorkflowStepDescription {
  readonly id: string;
  readonly kind: Step["kind"];
  /**
   * Nested steps, for the variants that contain them: `parallel` (all branches, flattened — the
   * branch grouping is a scheduling detail, not shape a reader needs), `branch` (each predicate's
   * steps plus the fallback), `foreach` and `dowhile` (their single inner step).
   *
   * Absent for leaf steps. A flat list would misreport a parallel or branching workflow as linear.
   */
  readonly steps?: readonly WorkflowStepDescription[];
}

/**
 * theokit#161 — the read-only shape of a committed workflow.
 *
 * Returned by `Workflow.describe()`. There is deliberately NO workflow registry to enumerate: a
 * `Workflow` is a value the caller constructs and holds, so the caller already knows which ones
 * exist. What it lacked was a way to DESCRIBE one. A registry would have added process-global state
 * that nothing ever releases, to re-answer a question the host can answer itself.
 *
 * @public
 */
export interface WorkflowDescription {
  readonly name: string;
  readonly steps: readonly WorkflowStepDescription[];
}

/* ─── Supporting types ─── */

/** D237 — retry policy applied per fn/agent step. */
export interface RetryPolicy {
  /** Total attempts (MIN 1, MAX 20). `1` = no retry. */
  readonly maxAttempts: number;
  readonly initialBackoffMs?: number;
  readonly backoffCoefficient?: number;
  readonly maximumBackoffMs?: number;
  readonly nonRetryableErrors?: ReadonlyArray<string>;
}

/** D247 — context handed to every step.fn. */
export interface StepContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly log: {
    debug: (msg: string, attrs?: Record<string, unknown>) => void;
    info: (msg: string, attrs?: Record<string, unknown>) => void;
    warn: (msg: string, attrs?: Record<string, unknown>) => void;
  };
  /** Pause the workflow; resume via `Workflow.resume({...})`. */
  readonly suspend: (payload?: unknown) => Promise<never>;
  /**
   * SE29 — the workflow's shared state (from `WorkflowOptions.initialState`,
   * mutated by {@link setState}), visible to every subsequent step in the run.
   * `undefined` when no `initialState`/`setState` has run. Persisted across
   * suspend/resume.
   */
  readonly state: unknown;
  /**
   * SE29 — update the shared state for subsequent steps. Validated against
   * `WorkflowOptions.stateSchema` when set (a mismatch throws
   * {@link WorkflowStateError}, which fails the step/run — Rule 8).
   */
  readonly setState: (next: unknown) => void;
}

/* ─── Result types ─── */

/**
 * The outcome of one step, appended to `WorkflowRun.stepResults` in execution order.
 *
 * A failing step does not throw out of `run()`. It lands here with `status: "failed"` and its error
 * flattened to `{ name, message }` — the thrown instance is gone by the time a caller sees it, so
 * match on `error.name` and never on `instanceof`.
 *
 * `"skipped"` occurs only for a `branch` step whose predicates all returned false and which declared
 * no fallback; its `output` is the step input, passed through unchanged. `"suspended"` marks the step
 * that called `StepContext.suspend()`, is always the last entry of the run, and carries no output.
 *
 * `attempts` means different things per kind. For `fn` and `agent` it counts execution attempts: 1
 * without a `retry` policy, and 0 when the step failed before its body ran — an `inputSchema`
 * rejection, a prompt template that threw, a `compensate` v1 refuses, or a cloud agent. For `dowhile`
 * it counts loop iterations instead.
 */
export interface StepResult {
  readonly stepId: string;
  readonly kind: Step["kind"];
  readonly status: "completed" | "failed" | "skipped" | "suspended" | "cancelled";
  readonly attempts: number;
  readonly durationMs: number;
  readonly output?: unknown;
  readonly error?: { name: string; message: string };
}

/**
 * The terminal record of one run — what `Workflow.run()` resolves to, what `Workflow.resume()`
 * returns, and what the `result` promise of `Workflow.stream()` settles with.
 *
 * Read `status`; do not rely on `catch`. A step that throws does not reject the promise, it ends the
 * run with `status: "failed"` and the error in `error`. Only `completed` populates `output`; `failed`
 * and `cancelled` (an aborted `signal`) populate `error`; `suspended` populates neither and means a
 * snapshot exists under `id` for `Workflow.resume()`. `running` is part of the union for the benefit
 * of a host tracking a run in flight — the executor only ever assembles a terminal one.
 *
 * `stepResults` is cumulative across a resume: the executor seeds it with the snapshot's prior
 * results, so the record of a resumed run covers the steps that ran before the suspend as well.
 */
export interface WorkflowRun<TOutput = unknown> {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed" | "suspended" | "cancelled";
  readonly output?: TOutput;
  readonly error?: { name: string; message: string };
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly stepResults: ReadonlyArray<StepResult>;
}

/**
 * The persisted state of a suspended run: written when a step calls `StepContext.suspend()`, read
 * back by `Workflow.resume()`. Callers never construct one — the type is exported so a host can
 * inspect what the persistence backend wrote.
 *
 * Snapshots are single-shot. `resume()` deletes the snapshot before re-entering the executor, so the
 * same one cannot be resumed twice; a second attempt raises
 * {@link WorkflowSnapshotNotFoundError}.
 *
 * Everything reachable from here must survive `JSON.stringify` — the store serializes on save even
 * for the memory backend, and raises `WorkflowNotSerializableError` rather than letting a `TypeError`
 * escape. That rules out BigInt, circular references and class instances in step outputs, in
 * `accumulatedInput` and in `state`.
 *
 * `currentStepId` is the suspending step, and resume continues from the step AFTER it. A workflow
 * definition edited between suspend and resume therefore either fails with
 * `WorkflowResumeStepNotFoundError` (the id is gone) or resumes at a position the author did not
 * intend (the id moved).
 */
export interface WorkflowSnapshot {
  /** v1 = pre-SE29 (no `state`); v2 = SE29 (carries `state`). Resume reads both. */
  readonly _schemaVersion: 1 | 2;
  readonly runId: string;
  readonly workflowName: string;
  readonly currentStepId: string;
  readonly suspendedPayload?: unknown;
  readonly stepResults: ReadonlyArray<StepResult>;
  readonly accumulatedInput: unknown;
  /** SE29 — shared state captured at suspend (v2). Absent on a v1 snapshot. */
  readonly state?: unknown;
  readonly suspendedAt: number;
}

/* ─── SE28 — streaming ─── */

/**
 * SE28 — a step-level workflow event emitted by `Workflow.stream()` as top-level
 * steps run. Coarse-grained (one event per top-level step; nested
 * parallel/branch/foreach emit as their single wrapping step), distinct from the
 * token-delta agent stream. Discriminate on `type`.
 *
 * @public
 */
export type WorkflowEvent =
  | { readonly type: "step_started"; readonly stepId: string }
  | { readonly type: "step_completed"; readonly stepId: string; readonly output: unknown }
  | {
      readonly type: "step_failed";
      readonly stepId: string;
      readonly error: { readonly name: string; readonly message: string };
    }
  | { readonly type: "workflow_suspended"; readonly stepId: string }
  | { readonly type: "workflow_completed" };

/**
 * SE28 — the async iterator returned by `Workflow.stream()`. Yields
 * {@link WorkflowEvent}s in execution order; `result` resolves to the same
 * terminal {@link WorkflowRun} the `run()` path returns (the authoritative
 * outcome — the stream ends when the run terminates).
 *
 * @public
 */
export type WorkflowStream<TOutput = unknown> = AsyncIterableIterator<WorkflowEvent> & {
  readonly result: Promise<WorkflowRun<TOutput>>;
};

/* ─── Options ─── */

/**
 * Where suspend snapshots are kept. Omitting `WorkflowOptions.persistence` selects the same store
 * `backend: "memory"` selects explicitly.
 *
 * `"memory"` is one process-wide map shared by every workflow, so a run suspended under it can only
 * be resumed by the process that suspended it, and only until it exits. `"json"` writes one
 * `{runId}.json` per snapshot into `dir` through an atomic write and survives a restart. Any suspend
 * point that waits on a human or an external system needs `"json"`; `"memory"` is for tests and for
 * suspends resolved within the same process.
 *
 * `dir` is required when `backend` is `"json"` and ignored otherwise — `Workflow.create()` rejects
 * the options up front when it is missing or empty, rather than failing at the first suspend.
 */
export interface WorkflowPersistenceOptions {
  readonly backend: "memory" | "json";
  /** Required for `backend: "json"`. */
  readonly dir?: string;
}

/**
 * Configuration for `Workflow.create()`, validated by Zod before the builder is handed back: a `name`
 * outside 1..128 characters, or `persistence.backend: "json"` without a `dir`, throws there rather
 * than at run time.
 *
 * `name` is an observability and error-message label, not an identity. Two workflows may share one;
 * the identity behind the single-flight lock is minted per `.commit()` call, so two separately
 * committed workflows never block each other however they are named.
 *
 * The three schemas are independent and each optional: `inputSchema` guards `run(input)` before step
 * 1, `outputSchema` guards the final value on the completed path only (a suspended or failed run
 * skips it), and `stateSchema` guards `initialState` plus every `StepContext.setState()` call. All
 * three must be synchronous — a schema carrying an async refinement is reported as a validation
 * failure with that explanation, never awaited.
 */
export interface WorkflowOptions {
  readonly name: string;
  readonly persistence?: WorkflowPersistenceOptions;
  /**
   * SE27 — Zod schema for the WHOLE workflow's input. When set, `run(input)`
   * validates `input` BEFORE step 1; a mismatch yields `status: "failed"` with a
   * typed {@link WorkflowInputError} in `error` (fail-fast, no step runs, no
   * silent coerce). Absent ⇒ no whole-workflow input validation (unchanged).
   */
  readonly inputSchema?: ZodType;
  /**
   * SE27 — Zod schema for the workflow's final output. When set, the terminal
   * `completed` output is validated before `WorkflowRun.output` is populated; a
   * mismatch yields `status: "failed"` with a typed {@link WorkflowOutputError}.
   * Only validated on the `completed` path (suspended/failed runs skip it).
   */
  readonly outputSchema?: ZodType;
  /**
   * SE29 — Zod schema for the workflow's shared state (see `StepContext.state` /
   * `setState`). When set, `initialState` and every `setState(next)` are
   * validated against it (a mismatch throws {@link WorkflowStateError}). When
   * `initialState` is absent, `state` starts as `undefined` and validation fires
   * on the first `setState` call.
   */
  readonly stateSchema?: ZodType;
  /**
   * SE29 — the initial shared state, seeded onto `StepContext.state` before
   * step 1. Validated against `stateSchema` when both are set. Persisted across
   * suspend/resume.
   */
  readonly initialState?: unknown;
  /** Internal — minted at `.commit()`. Not user-facing. */
  readonly workflowId?: string;
}

/**
 * Per-run options for `Workflow.run()` and `Workflow.stream()`.
 *
 * `signal` is combined with the run's internal single-flight signal and reaches every step through
 * `StepContext.signal`. The executor itself checks it at step boundaries, so a step that ignores the
 * signal runs to completion before the run reports `status: "cancelled"` — a step doing long I/O
 * should pass `ctx.signal` down to make abort prompt.
 *
 * `runId` is minted per call (`wfr-` plus 8 hex) unless you pass it, which is why concurrent runs of
 * one workflow do not interfere. Pinning it buys a deterministic id for resume, and buys the
 * single-flight lock with it: starting a second run of the same committed workflow under a `runId`
 * that is still in flight throws {@link WorkflowAlreadyRunningError}.
 */
export interface WorkflowRunOptions {
  readonly signal?: AbortSignal;
  /** Override run ID for deterministic resume (advanced; default = mintRunId). */
  readonly runId?: string;
  /**
   * Opt-in Task wrapping (ADRs D363, D374). Registers the workflow run
   * as a `Task` (kind="workflow") with a `wf-` namespaced id (D368,
   * EC-5). The task transitions terminal when `Workflow.run` resolves.
   *
   * Auto-id: `wf-{runId}`.
   *
   * @public
   */
  readonly task?: true | { id?: string; meta?: Record<string, unknown> };
}

/**
 * Arguments for `Workflow.resume()`.
 *
 * `workflow` is typed structurally as `{ run }`, but resume needs more than `run`: it reads the
 * committed steps and options off the instance and throws a plain `Error` — "Workflow.resume requires
 * an instance from Workflow.create().commit()" — for anything else. Pass the same committed
 * `Workflow` the suspended run came from, not a stand-in.
 *
 * `runId` selects the snapshot. An id with no snapshot throws
 * {@link WorkflowSnapshotNotFoundError}.
 *
 * `payload` becomes the input of the step after the suspend point, and is parsed against the
 * suspending step's `payloadSchema` first when it declared one (a mismatch throws out of `resume`).
 * Omit it to resume from the accumulated input captured in the snapshot instead — the two are
 * alternatives, not a merge.
 */
export interface WorkflowResumeOptions<TI = unknown> {
  readonly runId: string;
  readonly workflow: { run: (input: TI, opts?: WorkflowRunOptions) => Promise<WorkflowRun> };
  readonly payload?: unknown;
  readonly signal?: AbortSignal;
}
