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
  let cancelled: StepResult | undefined;
  const outputs: unknown[] = new Array(items.length);

  await Promise.all(
    items.map(async (item, idx) => {
      const release = await sem.acquire();
      try {
        if (cancelled !== undefined) return; // stop dispatching once an item was cancelled
        const r = await dispatch(step.step, item, exec);
        if (r.status === "cancelled") {
          cancelled = r;
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

  if (cancelled !== undefined) {
    return {
      stepId: step.id,
      kind: "foreach",
      status: "cancelled",
      attempts: 1,
      durationMs: Date.now() - startedAt,
      error: (cancelled as StepResult).error,
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
