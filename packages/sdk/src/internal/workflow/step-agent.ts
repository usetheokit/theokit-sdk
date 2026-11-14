/**
 * Execute an `AgentStep` — render the prompt template, call `agent.send`,
 * wait for completion, return the result text as step output (ADR D244,
 * D245).
 *
 * Cloud guard: agents marked as `CloudAgent` throw `UnsupportedRunOperationError`
 * (workflows are local-only in v1).
 *
 * @internal
 */

import { UnsupportedRunOperationError } from "../../errors.js";
import type { RunResult } from "../../types/run.js";
import type { AgentStep, StepContext, StepResult } from "../../types/workflow.js";
import { WorkflowSuspendedSentinel } from "./ctx.js";
import { errToShape } from "./error-shape.js";
import { withRetry } from "./retry-policy.js";

/** Waits for the run; an abort of `signal` cancels the in-flight run instead of waiting for the next step boundary. */
async function waitCancellable(
  run: { cancel(): Promise<void>; wait(): Promise<RunResult> },
  signal: AbortSignal,
): Promise<RunResult> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<RunResult>((resolve) => {
    onAbort = (): void => {
      void Promise.resolve(run.cancel()).catch(() => undefined);
      // Do not depend on wait() settling after cancel(): resolve as cancelled right away.
      resolve({ id: "", status: "cancelled" } as unknown as RunResult);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run.wait(), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function unwrapResult(result: RunResult, signal: AbortSignal): string {
  if (result.status === "cancelled" || signal.aborted) {
    throw new DOMException(String(signal.reason ?? "Aborted"), "AbortError");
  }
  if (result.status === "finished") return result.result ?? "";
  if (result.status === "error") {
    throw (result as { error?: Error }).error ?? new Error("agent.send errored");
  }
  throw new Error(`Unexpected agent status: ${result.status}`);
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err as { name?: string }).name === "AbortError";
}

function errorResult(
  step: AgentStep,
  err: unknown,
  signal: AbortSignal,
  startedAt: number,
): StepResult {
  return {
    stepId: step.id,
    kind: "agent",
    status: isAbort(err, signal) ? "cancelled" : "failed",
    attempts: 1,
    durationMs: Date.now() - startedAt,
    error: errToShape(err),
  };
}

export async function runAgentStep(
  step: AgentStep,
  input: unknown,
  ctx: StepContext,
): Promise<StepResult> {
  const startedAt = Date.now();
  // D244: cloud guard — workflows are LocalAgent-only in v1.
  const agentId = step.agent.agentId;
  if (typeof agentId === "string" && agentId.startsWith("bc-")) {
    return {
      stepId: step.id,
      kind: "agent",
      status: "failed",
      attempts: 0,
      durationMs: Date.now() - startedAt,
      error: errToShape(
        new UnsupportedRunOperationError(
          "Workflow agent steps not supported on CloudAgent yet (D244)." +
            ` agent="${agentId}", step="${step.id}"`,
          "workflow",
        ),
      ),
    };
  }

  let prompt: string;
  try {
    prompt =
      typeof step.promptTemplate === "string" ? step.promptTemplate : step.promptTemplate(input);
  } catch (err) {
    return {
      stepId: step.id,
      kind: "agent",
      status: "failed",
      attempts: 0,
      durationMs: Date.now() - startedAt,
      error: errToShape(err),
    };
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    return {
      stepId: step.id,
      kind: "agent",
      status: "failed",
      attempts: 0,
      durationMs: Date.now() - startedAt,
      error: errToShape(
        new Error(`agentStep "${step.id}": rendered prompt must be a non-empty string`),
      ),
    };
  }

  const exec = async (): Promise<string> => {
    // SE3 — forward the step's provenance onto the agent's turn (metadata-only).
    const run = await step.agent.send(
      prompt,
      step.origin !== undefined ? { origin: step.origin } : undefined,
    );
    const result = await waitCancellable(run, ctx.signal);
    return unwrapResult(result, ctx.signal);
  };

  try {
    const { value, attempts } =
      step.retry !== undefined
        ? await withRetry(exec, step.retry, ctx.signal)
        : { value: await exec(), attempts: 1 };
    return {
      stepId: step.id,
      kind: "agent",
      status: "completed",
      attempts,
      durationMs: Date.now() - startedAt,
      output: value,
    };
  } catch (err) {
    // Re-throw suspend sentinel so the executor can persist a snapshot.
    if (err instanceof WorkflowSuspendedSentinel) throw err;
    return errorResult(step, err, ctx.signal, startedAt);
  }
}
