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
import type { AgentStep, StepContext, StepResult } from "../../types/workflow.js";
import { WorkflowSuspendedSentinel } from "./ctx.js";
import { errToShape } from "./error-shape.js";
import { withRetry } from "./retry-policy.js";

/** Thrown by `waitOrCancel` when the in-flight run was cancelled; mapped to a `cancelled` step result. */
const CANCELLED = Symbol("agent-step-cancelled");

class AgentStepCancelled extends Error {}

/** Cancels `run` once the signal aborts; resolves "aborted" then. Call `off` to detach. */
function watchAbort(
  run: { cancel?: () => unknown },
  signal: AbortSignal,
): { aborted: Promise<"aborted">; off: () => void } {
  let off = (): void => {};
  const aborted = new Promise<"aborted">((resolve) => {
    const fire = (): void => {
      try {
        void Promise.resolve(run.cancel?.()).catch(() => {});
      } catch {
        // a run that cannot be cancelled still settles the step as cancelled
      }
      resolve("aborted");
    };
    if (signal.aborted) return fire();
    signal.addEventListener("abort", fire, { once: true });
    off = () => signal.removeEventListener("abort", fire);
  });
  return { aborted, off };
}

function resultText(result: { status: string; result?: string }): string {
  if (result.status === "finished") return result.result ?? "";
  if (result.status === "error") {
    throw (result as { error?: Error }).error ?? new Error("agent.send errored");
  }
  throw new Error(`Unexpected agent status: ${result.status}`);
}

async function waitOrCancel<R extends { wait(): Promise<{ status: string }> }>(
  run: R,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<R["wait"]>>> {
  const watch = watchAbort(run as { cancel?: () => unknown }, signal);
  try {
    const raced = await Promise.race([run.wait(), watch.aborted]);
    if (raced === "aborted" || raced.status === "cancelled") {
      throw new AgentStepCancelled("agent run cancelled");
    }
    return raced as Awaited<ReturnType<R["wait"]>>;
  } finally {
    watch.off();
  }
}

function cancelledResult(step: AgentStep, startedAt: number, signal: AbortSignal): StepResult {
  return {
    stepId: step.id,
    kind: "agent",
    status: "cancelled",
    attempts: 1,
    durationMs: Date.now() - startedAt,
    error: { name: "AbortError", message: String(signal.reason ?? "Aborted") },
  };
}

function errorResult(
  err: unknown,
  step: AgentStep,
  startedAt: number,
  signal: AbortSignal,
): StepResult {
  // Re-throw suspend sentinel so the executor can persist a snapshot.
  if (err instanceof WorkflowSuspendedSentinel) throw err;
  // `withRetry` throws AbortError when the signal fires before an attempt or during backoff.
  if (signal.aborted && err instanceof Error && err.name === "AbortError") {
    return cancelledResult(step, startedAt, signal);
  }
  return {
    stepId: step.id,
    kind: "agent",
    status: "failed",
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

  // A cancelled run RETURNS the sentinel (never throws), so `withRetry` cannot retry it.
  const exec = async (): Promise<string | typeof CANCELLED> => {
    // SE3 — forward the step's provenance onto the agent's turn (metadata-only).
    const sending = Promise.resolve(
      step.agent.send(prompt, step.origin !== undefined ? { origin: step.origin } : undefined),
    );
    // `send` can queue behind another run or slow startup: race it against the signal, and cancel a
    // run that arrives after the abort so it never starts work.
    let onAbort = (): void => {};
    const abortedWhileSending = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    let run: Awaited<typeof sending>;
    try {
      const first = await Promise.race([sending, abortedWhileSending]);
      if (first === "aborted") {
        void sending.then((late) => late.cancel?.()).catch(() => {});
        return CANCELLED;
      }
      run = first;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }
    try {
      return resultText(await waitOrCancel(run, ctx.signal));
    } catch (err) {
      if (err instanceof AgentStepCancelled) return CANCELLED;
      throw err;
    }
  };

  try {
    const { value, attempts } =
      step.retry !== undefined
        ? await withRetry(exec, step.retry, ctx.signal)
        : { value: await exec(), attempts: 1 };
    if (value === CANCELLED) return cancelledResult(step, startedAt, ctx.signal);
    return {
      stepId: step.id,
      kind: "agent",
      status: "completed",
      attempts,
      durationMs: Date.now() - startedAt,
      output: value,
    };
  } catch (err) {
    return errorResult(err, step, startedAt, ctx.signal);
  }
}
