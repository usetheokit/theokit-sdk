/**
 * Workflow executor (ADRs D230-D248).
 *
 * Walks `steps[]` sequentially, dispatching to per-kind handlers. Handles
 * suspend (sentinel pattern; D236), single-flight (D242), abort signal
 * boundaries (D245), and snapshot persistence opt-in (D235).
 *
 * @internal
 */

import type {
  Step,
  StepContext,
  StepResult,
  WorkflowEvent,
  WorkflowOptions,
  WorkflowResumeOptions,
  WorkflowRun,
  WorkflowRunOptions,
  WorkflowSnapshot,
} from "../../types/workflow.js";
import {
  WorkflowInputError,
  WorkflowOutputError,
  WorkflowResumeStepNotFoundError,
  WorkflowResumeWorkflowMismatchError,
  WorkflowSnapshotNotFoundError,
  WorkflowStateError,
} from "../../workflow-errors.js";
import { combineSignals, makeStepContext, WorkflowSuspendedSentinel } from "./ctx.js";
import { errToShape } from "./error-shape.js";
import {
  abortRun,
  assembleRun,
  makeStateController,
  validateWorkflowSchema,
} from "./executor-helpers.js";
import { mintRunId } from "./run-id.js";
import { acquireSingleFlight } from "./single-flight.js";
import { getSnapshotStoreFor } from "./snapshot-store.js";
import { runAgentStep } from "./step-agent.js";
import { runBranchStep } from "./step-branch.js";
import { runDowhileStep } from "./step-dowhile.js";
import type { StepExecution } from "./step-execution.js";
import { runFnStep } from "./step-fn.js";
import { runForeachStep } from "./step-foreach.js";
import { runParallelStep } from "./step-parallel.js";
import { runSleepStep } from "./step-sleep.js";
import { startWorkflowRunSpan, startWorkflowStepSpan } from "./telemetry.js";

interface SuspendOutcome<T> {
  kind: "suspended" | "failed";
  run: WorkflowRun<T>;
}

async function handleSuspend<T>(
  err: WorkflowSuspendedSentinel,
  ctx: {
    runId: string;
    name: string;
    step: Step;
    stepResults: StepResult[];
    acc: unknown;
    options: WorkflowOptions;
    startedAt: number;
    stepSpan: ReturnType<typeof startWorkflowStepSpan>;
    /** SE29 — the StepContext, read for its current shared `state`. */
    stepCtx: StepContext;
  },
): Promise<SuspendOutcome<T>> {
  try {
    await saveSnapshot({
      runId: ctx.runId,
      workflowName: ctx.options.name,
      currentStepId: ctx.step.id,
      suspendedPayload: err.payload,
      stepResults: ctx.stepResults,
      accumulatedInput: ctx.acc,
      state: ctx.stepCtx.state, // SE29 — capture the shared state at suspend
      options: ctx.options,
    });
  } catch (snapErr) {
    ctx.stepSpan.setAttribute("step.status", "failed");
    ctx.stepSpan.end();
    return {
      kind: "failed",
      run: assembleRun<T>({
        runId: ctx.runId,
        name: ctx.name,
        status: "failed",
        stepResults: ctx.stepResults,
        startedAt: ctx.startedAt,
        error: errToShape(snapErr),
      }),
    };
  }
  ctx.stepSpan.setAttribute("step.status", "suspended");
  ctx.stepSpan.end();
  return {
    kind: "suspended",
    run: assembleRun<T>({
      runId: ctx.runId,
      name: ctx.name,
      status: "suspended",
      stepResults: [
        ...ctx.stepResults,
        {
          stepId: ctx.step.id,
          kind: ctx.step.kind,
          status: "suspended",
          attempts: 1,
          durationMs: 0,
          output: undefined,
        },
      ],
      startedAt: ctx.startedAt,
    }),
  };
}

async function runOneStep<T>(args: {
  step: Step;
  acc: unknown;
  ctx: StepContext;
  options: WorkflowOptions;
  stepResults: StepResult[];
  runId: string;
  name: string;
  startedAt: number;
}): Promise<{ kind: "ok"; result: StepResult } | { kind: "terminal"; run: WorkflowRun<T> }> {
  const stepSpan = startWorkflowStepSpan({
    stepId: args.step.id,
    kind: args.step.kind,
    attempt: 1,
  });
  let result: StepResult;
  try {
    result = await dispatchStep(args.step, args.acc, {
      ctx: args.ctx,
      options: args.options,
      prevStepResults: args.stepResults,
      dispatch: dispatchStep,
    });
  } catch (err) {
    if (err instanceof WorkflowSuspendedSentinel) {
      const outcome = await handleSuspend<T>(err, { ...args, stepSpan, stepCtx: args.ctx });
      return { kind: "terminal", run: outcome.run };
    }
    result = {
      stepId: args.step.id,
      kind: args.step.kind,
      status: "failed",
      attempts: 1,
      durationMs: 0,
      error: errToShape(err),
    };
  }
  stepSpan.setAttribute("step.status", result.status);
  stepSpan.setAttribute("step.attempts", result.attempts);
  stepSpan.end();
  return { kind: "ok", result };
}

interface LoopParams {
  options: WorkflowOptions;
  steps: ReadonlyArray<Step>;
  input: unknown;
  ctx: StepContext;
  runId: string;
  startedAt: number;
  signal: AbortSignal;
  /** M3 #62 — prior step outputs restored on resume (else resume is lossy). */
  initialStepResults?: ReadonlyArray<StepResult>;
  /** SE28 — sink for step-level stream events (top-level steps). */
  onStepEvent?: (event: WorkflowEvent) => void;
}

/** Emit events + branch on one step's outcome. Returns a terminal run, or the new acc. */
function handleStepOutcome<TO>(
  outcome: { kind: "ok"; result: StepResult } | { kind: "terminal"; run: WorkflowRun<TO> },
  step: Step,
  loop: { stepResults: StepResult[]; runId: string; name: string; startedAt: number },
  onStepEvent?: (event: WorkflowEvent) => void,
): { terminal: WorkflowRun<TO> } | { acc: unknown } {
  if (outcome.kind === "terminal") {
    // A snapshot-SAVE failure also returns terminal (status "failed") — only emit
    // workflow_suspended when the run actually suspended (else the consumer would
    // resume a run with no snapshot). A failed terminal has no event; read `result`.
    if (outcome.run.status === "suspended") {
      onStepEvent?.({ type: "workflow_suspended", stepId: step.id });
    }
    return { terminal: outcome.run };
  }
  loop.stepResults.push(outcome.result);
  if (outcome.result.status === "cancelled") {
    return {
      terminal: assembleRun<TO>({
        runId: loop.runId,
        name: loop.name,
        status: "cancelled",
        stepResults: loop.stepResults,
        startedAt: loop.startedAt,
        error: outcome.result.error,
      }),
    };
  }
  if (outcome.result.status === "failed") {
    onStepEvent?.({
      type: "step_failed",
      stepId: step.id,
      error: outcome.result.error ?? { name: "WorkflowStepError", message: "step failed" },
    });
    return {
      terminal: assembleRun<TO>({
        runId: loop.runId,
        name: loop.name,
        status: "failed",
        stepResults: loop.stepResults,
        startedAt: loop.startedAt,
        error: outcome.result.error,
      }),
    };
  }
  onStepEvent?.({ type: "step_completed", stepId: step.id, output: outcome.result.output });
  return { acc: outcome.result.output };
}

async function runStepsLoop<TO>(params: LoopParams): Promise<WorkflowRun<TO>> {
  const { options, steps, ctx, runId, startedAt, signal, onStepEvent } = params;
  // M3 #62 — seed with prior step outputs so a resumed workflow is not lossy.
  const stepResults: StepResult[] = [...(params.initialStepResults ?? [])];
  const loop = { stepResults, runId, name: options.name, startedAt };
  let acc: unknown = params.input;
  for (const step of steps) {
    if (signal.aborted) return abortRun<TO>(options.name, runId, startedAt, stepResults, signal);
    onStepEvent?.({ type: "step_started", stepId: step.id });
    const outcome = await runOneStep<TO>({
      step,
      acc,
      ctx,
      options,
      stepResults,
      runId,
      name: options.name,
      startedAt,
    });
    const handled = handleStepOutcome<TO>(outcome, step, loop, onStepEvent);
    if ("terminal" in handled) return handled.terminal;
    acc = handled.acc;
  }
  // SE27 — validate the whole-workflow output only on the terminal completed path.
  const outputIssues = validateWorkflowSchema(options.outputSchema, acc);
  if (outputIssues !== undefined) {
    return assembleRun<TO>({
      runId,
      name: options.name,
      status: "failed",
      stepResults,
      startedAt,
      error: errToShape(new WorkflowOutputError(options.name, outputIssues)),
    });
  }
  onStepEvent?.({ type: "workflow_completed" });
  return assembleRun<TO>({
    runId,
    name: options.name,
    status: "completed",
    output: acc as TO,
    stepResults,
    startedAt,
  });
}

/** M3 #62 — internal-only resume seam: prior step outputs are NOT on the public
 * WorkflowRunOptions (a consumer must not inject fabricated results into a fresh run);
 * resumeWorkflow sets them via this cast. */
type InternalRunOpts = WorkflowRunOptions & {
  readonly initialStepResults?: ReadonlyArray<StepResult>;
  /** SE28 — internal step-event sink threaded by `Workflow.stream()`. */
  readonly onStepEvent?: (event: WorkflowEvent) => void;
  /** SE29 — shared state restored from a snapshot on resume. */
  readonly restoredState?: unknown;
};

export async function executeWorkflow<TInput, TOutput>(
  options: WorkflowOptions,
  steps: ReadonlyArray<Step>,
  input: TInput,
  runOpts?: WorkflowRunOptions,
): Promise<WorkflowRun<TOutput>> {
  const runId = runOpts?.runId ?? mintRunId();
  const workflowId = options.workflowId ?? `wf-anon`;
  const flight = acquireSingleFlight(workflowId, runId, options.name);
  const startedAt = Date.now();
  const signal = combineSignals(runOpts?.signal, flight.signal);
  const runSpan = startWorkflowRunSpan({ workflowName: options.name, runId });

  if (signal.aborted) {
    flight.release();
    runSpan.setAttribute("workflow.status", "cancelled");
    runSpan.end();
    return abortRun<TOutput>(options.name, runId, startedAt, [], signal);
  }

  const internal = runOpts as InternalRunOpts | undefined;
  // SE29 — seed shared state from the resume snapshot (if any) else initialState.
  const seededState =
    internal?.restoredState !== undefined ? internal.restoredState : options.initialState;
  const stateController = makeStateController(options, seededState);
  const ctx: StepContext = makeStepContext(runId, signal, stateController);
  try {
    // SE27 — validate the whole-workflow input BEFORE any step runs (fail-fast).
    const inputIssues = validateWorkflowSchema(options.inputSchema, input);
    if (inputIssues !== undefined) {
      return assembleRun<TOutput>({
        runId,
        name: options.name,
        status: "failed",
        stepResults: [],
        startedAt,
        error: errToShape(new WorkflowInputError(options.name, inputIssues)),
      });
    }
    // SE29 — validate the seeded state (fail-fast) before any step reads it.
    const stateIssues =
      seededState !== undefined
        ? validateWorkflowSchema(options.stateSchema, seededState)
        : undefined;
    if (stateIssues !== undefined) {
      return assembleRun<TOutput>({
        runId,
        name: options.name,
        status: "failed",
        stepResults: [],
        startedAt,
        error: errToShape(new WorkflowStateError(options.name, stateIssues)),
      });
    }
    return await runStepsLoop<TOutput>({
      options,
      steps,
      input,
      ctx,
      runId,
      startedAt,
      signal,
      ...(internal?.initialStepResults !== undefined
        ? { initialStepResults: internal.initialStepResults }
        : {}),
      ...(internal?.onStepEvent !== undefined ? { onStepEvent: internal.onStepEvent } : {}),
    });
  } finally {
    runSpan.end();
    flight.release();
  }
}

/**
 * Dispatch single step to the right handler. Exhaustive over `step.kind`.
 */
export async function dispatchStep(
  step: Step,
  input: unknown,
  exec: StepExecution,
): Promise<StepResult> {
  const { ctx } = exec;
  switch (step.kind) {
    case "fn":
      return runFnStep(step, input, ctx);
    case "agent":
      return runAgentStep(step, input, ctx);
    case "parallel":
      return runParallelStep(step, input, exec);
    case "branch":
      return runBranchStep(step, input, exec);
    case "foreach":
      return runForeachStep(step, input, exec);
    case "dowhile":
      return runDowhileStep(step, input, exec);
    case "sleep":
      return runSleepStep(step, input, ctx);
    case "suspend":
      // Standalone suspend: throw sentinel so executor catches.
      throw new WorkflowSuspendedSentinel(undefined);
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown step kind: ${(_exhaustive as Step).kind}`);
    }
  }
}

interface SnapshotParams {
  runId: string;
  workflowName: string;
  currentStepId: string;
  suspendedPayload?: unknown;
  stepResults: ReadonlyArray<StepResult>;
  accumulatedInput: unknown;
  /** SE29 — shared state captured at suspend. */
  state: unknown;
  options: WorkflowOptions;
}

async function saveSnapshot(p: SnapshotParams): Promise<void> {
  const snapshot: WorkflowSnapshot = {
    _schemaVersion: 2, // SE29 — carries `state`
    runId: p.runId,
    workflowName: p.workflowName,
    currentStepId: p.currentStepId,
    suspendedPayload: p.suspendedPayload,
    stepResults: p.stepResults,
    accumulatedInput: p.accumulatedInput,
    ...(p.state !== undefined ? { state: p.state } : {}),
    suspendedAt: Date.now(),
  };
  const store = getSnapshotStoreFor(p.options);
  await store.save(snapshot);
}

/* ─── Resume ─── */

export async function resumeWorkflow<TO>(opts: WorkflowResumeOptions): Promise<WorkflowRun<TO>> {
  // We need access to the workflow's internal options/steps. The public
  // resume API hands us a `workflow` reference exposing `.run` only — for
  // v1 we accept the user re-running the same workflow with the snapshot's
  // accumulated input + payload merged. Full resume-from-step support
  // would require exposing `__steps` and `__options`; v1 ships a simpler
  // "re-run from input" semantics gated by snapshot lookup.
  const wfInternal = opts.workflow as {
    __options?: WorkflowOptions;
    __steps?: ReadonlyArray<Step>;
    run: (input: unknown, runOpts?: WorkflowRunOptions) => Promise<WorkflowRun<TO>>;
  };
  const options = wfInternal.__options;
  const steps = wfInternal.__steps;
  if (options === undefined || steps === undefined) {
    throw new Error("Workflow.resume requires an instance from Workflow.create().commit()");
  }
  const store = getSnapshotStoreFor(options);
  const snapshot = await store.load(opts.runId);
  if (snapshot === undefined) {
    throw new WorkflowSnapshotNotFoundError(opts.runId);
  }
  // Checked before the step lookup and before the delete: a run id from another workflow is refused
  // and its snapshot stays for the workflow that wrote it.
  if (snapshot.workflowName !== options.name) {
    throw new WorkflowResumeWorkflowMismatchError(opts.runId, snapshot.workflowName, options.name);
  }
  // EC-8: verify the currentStepId exists in the supplied workflow.
  const stepIdx = steps.findIndex((s) => s.id === snapshot.currentStepId);
  if (stepIdx < 0) {
    throw new WorkflowResumeStepNotFoundError(snapshot.currentStepId, snapshot.workflowName);
  }

  // Validate payload if the suspend step declared a schema.
  const suspendStep = steps[stepIdx];
  if (
    suspendStep !== undefined &&
    suspendStep.kind === "suspend" &&
    suspendStep.payloadSchema !== undefined
  ) {
    suspendStep.payloadSchema.parse(opts.payload);
  }

  // For v1: continue from stepIdx + 1 with `payload` (if any) as the new
  // accumulated input. This is intentionally simpler than full state
  // restoration; the snapshot's `accumulatedInput` is preserved for
  // observability but the resume input is determined by the caller's
  // payload (or the snapshot's accumulator if payload is undefined).
  const resumeInput = opts.payload !== undefined ? opts.payload : snapshot.accumulatedInput;
  const remainingSteps = steps.slice(stepIdx + 1);

  // Drop snapshot once we begin (single-shot semantics).
  await store.delete(opts.runId);

  return executeWorkflow<unknown, TO>(options, remainingSteps, resumeInput, {
    signal: opts.signal,
    runId: opts.runId,
    // M3 #62 — restore prior step outputs so the resumed run is not lossy (internal seam).
    initialStepResults: snapshot.stepResults,
    // SE29 — restore shared state (v2 snapshot). A v1 snapshot has no `state` →
    // executeWorkflow falls back to `options.initialState`.
    ...(snapshot.state !== undefined ? { restoredState: snapshot.state } : {}),
  } as InternalRunOpts);
}
