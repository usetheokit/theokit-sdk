/**
 * Build the `StepContext` passed to every step.fn. The `suspend` method
 * throws a `WorkflowSuspendedSentinel` (defined here) that the executor
 * catches to persist a snapshot (D236).
 *
 * @internal
 */

import type { StepContext } from "../../types/workflow.js";
import { diag } from "../diagnostics.js";
import { redactSecrets } from "../security/index.js";

/** Sentinel thrown by `ctx.suspend()`; only the executor catches it. */
export class WorkflowSuspendedSentinel extends Error {
  override readonly name = "WorkflowSuspendedSentinel";
  constructor(public readonly payload?: unknown) {
    super("__workflow_suspended__");
  }
}

/** SE29 — the per-run shared-state seam wired into `StepContext.state`/`setState`. */
export interface StateController {
  getState: () => unknown;
  setState: (next: unknown) => void;
}

export function makeStepContext(
  runId: string,
  signal: AbortSignal,
  state: StateController,
): StepContext {
  return {
    runId,
    signal,
    log: {
      debug: (msg, attrs) => emit("debug", runId, msg, attrs),
      info: (msg, attrs) => emit("info", runId, msg, attrs),
      warn: (msg, attrs) => emit("warn", runId, msg, attrs),
    },
    suspend: async (payload?: unknown) => {
      throw new WorkflowSuspendedSentinel(payload);
    },
    // SE29 — read reflects the current shared state; write goes through the
    // controller (which validates against `stateSchema`).
    get state(): unknown {
      return state.getState();
    },
    setState: (next: unknown): void => state.setState(next),
  };
}

/**
 * The logging surface every workflow step gets, on the interceptable channel.
 *
 * These were direct `console.warn` / `console.log` calls — the exact path theokit#147 exists to
 * close, in the words of `internal/diagnostics.ts`: "those writes interleave with the render and
 * CORRUPT THE FRAME" in a TUI host. `step-branch.ts`, in this same folder, was converted in that
 * sweep and routes its predicate warning through `diag`.
 *
 * `diagnostics.ts` allowlists "the Workflow logger" as a seam whose destination the CALLER chooses.
 * Measured before changing this: it does not. `types/workflow.ts` declares no logger option, and
 * `StepContext.log` is constructed here with no injection point, so a consumer had no way to
 * redirect it. The exemption described something that was never built.
 *
 * The level is formatted into the message rather than becoming a channel, matching the other
 * converted sites — `diag` is deliberately not a logger with levels, and inventing one here would be
 * the requirement nobody asked for that its own docblock warns against.
 */
function emit(
  level: "debug" | "info" | "warn",
  runId: string,
  msg: string,
  attrs?: Record<string, unknown>,
): void {
  const suffix = attrs === undefined ? "" : ` ${JSON.stringify(attrs)}`;
  diag(redactSecrets(`[workflow ${runId}] ${level}: ${msg}${suffix}\n`));
}

/**
 * Combine the caller-supplied signal with the flight signal so abort on
 * either side cancels the workflow run.
 */
export function combineSignals(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => s !== undefined);
  if (valid.length === 0) return new AbortController().signal;
  if (valid.length === 1) return valid[0]!;
  const ctrl = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/** Merge two signals; `dispose` detaches the listeners from the inputs (call when the step settles). */
export function mergeSignals(
  a: AbortSignal,
  b: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (a.aborted) return { signal: a, dispose: () => {} };
  if (b.aborted) return { signal: b, dispose: () => {} };
  const ctrl = new AbortController();
  const onAbortA = (): void => ctrl.abort(a.reason);
  const onAbortB = (): void => ctrl.abort(b.reason);
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return {
    signal: ctrl.signal,
    dispose: () => {
      a.removeEventListener("abort", onAbortA);
      b.removeEventListener("abort", onAbortB);
    },
  };
}
