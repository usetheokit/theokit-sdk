/**
 * Execute a `FnStep` — call the user-supplied function with `input` + `ctx`.
 * Wraps in `withRetry` if a retry policy is set (D237).
 *
 * Validates input/output via Zod when schemas are supplied. EC-4 / D229
 * pattern: empty/undefined input parses as `{}` only when schema is defined.
 *
 * @internal
 */

import type { FnStep, StepContext, StepResult } from "../../types/workflow.js";
import { WorkflowCompensateNotImplementedError } from "../../workflow-errors.js";
import { WorkflowSuspendedSentinel } from "./ctx.js";
import { errToShape } from "./error-shape.js";
import { withRetry } from "./retry-policy.js";

function failedFnResult(
  stepId: string,
  attempts: number,
  startedAt: number,
  err: unknown,
): StepResult {
  return {
    stepId,
    kind: "fn",
    status: "failed",
    attempts,
    durationMs: Date.now() - startedAt,
    error: errToShape(err),
  };
}

function validate(schema: { parse: (v: unknown) => unknown } | undefined, value: unknown): unknown {
  if (schema === undefined) return undefined;
  schema.parse(value);
  return undefined;
}

async function execWithRetry(
  step: FnStep,
  input: unknown,
  ctx: StepContext,
): Promise<{ value: unknown; attempts: number }> {
  const exec = async (): Promise<unknown> => step.fn(input, ctx);
  if (step.retry !== undefined) return withRetry(exec, step.retry, ctx.signal);
  return { value: await exec(), attempts: 1 };
}

export async function runFnStep(
  step: FnStep,
  input: unknown,
  ctx: StepContext,
  topLevel = false,
): Promise<StepResult> {
  const startedAt = Date.now();
  // Compensation runs only for top-level steps (the executor owns the reverse pass); a nested
  // `compensate` is refused loudly rather than silently ignored.
  if (step.compensate !== undefined && !topLevel) {
    return failedFnResult(
      step.id,
      0,
      startedAt,
      new WorkflowCompensateNotImplementedError(step.id),
    );
  }
  try {
    validate(step.inputSchema, input);
  } catch (err) {
    return failedFnResult(step.id, 0, startedAt, err);
  }

  try {
    const { value, attempts } = await execWithRetry(step, input, ctx);
    try {
      validate(step.outputSchema, value);
    } catch (err) {
      return failedFnResult(step.id, attempts, startedAt, err);
    }
    return {
      stepId: step.id,
      kind: "fn",
      status: "completed",
      attempts,
      durationMs: Date.now() - startedAt,
      output: value,
    };
  } catch (err) {
    if (err instanceof WorkflowSuspendedSentinel) throw err;
    return failedFnResult(step.id, 1, startedAt, err);
  }
}
