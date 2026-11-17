/**
 * Execute a `ForeachStep` — map a step over the output of an upstream step.
 *
 * EC-7 absorbed: `iterableFrom` MUST reference a top-level step (one of
 * `prevStepResults`). Inner steps from inside `.parallel` / `.branch` /
 * `.foreach` are not reachable.
 *
 * @internal
 */

import type { ForeachStep, StepResult } from "../../types/workflow.js";
import { createSemaphore } from "../concurrency/async-semaphore.js";
import { errToShape } from "./error-shape.js";
import type { StepExecution } from "./step-execution.js";

export async function runForeachStep(
  step: ForeachStep,
  _input: unknown,
  exec: StepExecution,
): Promise<StepResult> {
  const { prevStepResults, dispatch } = exec;
  const startedAt = Date.now();

  // EC-7: top-level step lookup only.
  const sourceResult = prevStepResults.find((r) => r.stepId === step.iterableFrom);
  if (sourceResult === undefined) {
    return {
      stepId: step.id,
      kind: "foreach",
      status: "failed",
      attempts: 0,
      durationMs: Date.now() - startedAt,
      error: errToShape(
        new Error(
          `foreach.iterableFrom "${step.iterableFrom}" not found in top-level steps. ` +
            `It must reference an earlier top-level step ID — nested step IDs inside ` +
            `parallel/branch/foreach blocks are not visible here.`,
        ),
      ),
    };
  }

  const items = sourceResult.output;
  if (!Array.isArray(items)) {
    return {
      stepId: step.id,
      kind: "foreach",
      status: "failed",
      attempts: 0,
      durationMs: Date.now() - startedAt,
      error: errToShape(
        new Error(
          `foreach.iterableFrom "${step.iterableFrom}" output must be Array, got ${typeof items}.`,
        ),
      ),
    };
  }

  if (items.length === 0) {
    return {
      stepId: step.id,
      kind: "foreach",
      status: "completed",
      attempts: 1,
      durationMs: Date.now() - startedAt,
      output: [],
    };
  }

  const concurrency = step.concurrency ?? 4;
  const sem = createSemaphore(Math.max(1, Math.min(concurrency, items.length)));
  const failures: Error[] = [];
  const outputs: unknown[] = new Array(items.length);

  // Siblings run under a signal of their own: an item that cancels itself aborts it.
  const siblingCtrl = new AbortController();
  const itemSignal = mergeSignals(exec.ctx.signal, siblingCtrl.signal);
  const itemExec: StepExecution = { ...exec, ctx: { ...exec.ctx, signal: itemSignal } };
  let cancelledResult: StepResult | undefined;

  await Promise.all(
    items.map(async (item, idx) => {
      const release = await sem.acquire();
      try {
        if (itemSignal.aborted) return;
        const r = await dispatch(step.step, item, itemExec);
        if (r.status === "cancelled") {
          cancelledResult ??= r;
          siblingCtrl.abort(r.error?.message ?? "foreach item cancelled");
        } else if (r.status === "failed") {
          failures.push(new Error(`foreach item ${idx} failed: ${r.error?.message ?? "unknown"}`));
        } else {
          outputs[idx] = r.output;
        }
      } finally {
        release();
      }
    }),
  );

  if (cancelledResult !== undefined || exec.ctx.signal.aborted) {
    const reason = exec.ctx.signal.reason;
    return {
      stepId: step.id,
      kind: "foreach",
      status: "cancelled",
      attempts: 1,
      durationMs: Date.now() - startedAt,
      error: (cancelledResult as StepResult | undefined)?.error ?? {
        name: "AbortError",
        message: String(reason ?? "Aborted"),
      },
    };
  }

  if (failures.length > 0) {
    return {
      stepId: step.id,
      kind: "foreach",
      status: "failed",
      attempts: 1,
      durationMs: Date.now() - startedAt,
      error: errToShape(
        new AggregateError(failures, `foreach "${step.id}" had ${failures.length} failure(s)`),
      ),
    };
  }

  return {
    stepId: step.id,
    kind: "foreach",
    status: "completed",
    attempts: 1,
    durationMs: Date.now() - startedAt,
    output: outputs,
  };
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  a.addEventListener("abort", () => ctrl.abort(a.reason), { once: true });
  b.addEventListener("abort", () => ctrl.abort(b.reason), { once: true });
  return ctrl.signal;
}
