/**
 * SE19 — expose a {@link Workflow} as an agent tool.
 *
 * Split out of `workflow.ts` because it answers a different question: that file is about BUILDING a
 * workflow; this one is about handing a built workflow to an agent as a callable. The file-size gate
 * is what surfaced the seam, and the seam is real — nothing here runs while steps are composed.
 *
 * Re-exported from `workflow.ts`, so `@theokit/sdk/workflow` is unchanged.
 *
 * NOTE ON THE MODULE TAG: this header deliberately carries no internal-visibility tag, and does not
 * even name one — TypeScript attaches a file-leading docblock to the FIRST declaration below it, and
 * `stripInternal: true` (tsconfig.base) then deletes that declaration from the emitted `.d.ts`.
 * `tsc --noEmit` stays clean and the declaration rollup fails with `"X" is not exported by "..."`.
 * Measured twice on this file on 2026-09-01: once with the tag, and again when the comment
 * EXPLAINING the trap quoted the tag verbatim and re-armed it.
 */

import { type ZodType, z } from "zod";

import { TheokitAgentError } from "./errors.js";
import { toJsonSchema } from "./internal/zod-to-json-schema.js";
import type { CustomTool } from "./types/agent.js";
// `WorkflowRun` comes from the TYPE module, never from `workflow.ts`. Importing it from there
// created a file cycle — workflow.ts re-exports this module — which madge caught with
// tsPreCompilationDeps on, since a type-only import is still an edge. `workflowAsTool` never needed
// the `Workflow` class anyway: its parameter is structural, `{ run: (input) => Promise<...> }`.
import type { WorkflowResumeOptions, WorkflowRun } from "./types/workflow.js";

/* ─── SE19 — workflowAsTool (expose a Workflow as an agent tool) ─── */

/**
 * Raised by a {@link workflowAsTool} or {@link workflowResumeTool} tool when the
 * run does not reach `status: "completed"` (a step failed, the run was cancelled,
 * or it suspended without `reportSuspended`, which returns a report instead).
 * The dispatch converts it to a `tool_result(isError)`.
 *
 * @public
 */
export class WorkflowToolError extends TheokitAgentError {
  override readonly name = "WorkflowToolError";
  override readonly code = "workflow_tool_failed" as const;
  constructor(
    readonly toolName: string,
    readonly workflowStatus: string,
    readonly workflowError?: { name: string; message: string },
  ) {
    // Not retryable at this level: the workflow already ran and reported its own status; whether the
    // underlying failure is transient is a question for the workflow's retry policy, not the tool wrapper.
    super(
      `workflowAsTool("${toolName}"): workflow ${workflowStatus}${
        workflowError ? `: ${workflowError.message}` : ""
      }`,
      { code: "workflow_tool_failed", isRetryable: false },
    );
  }
}

/** Spec for {@link workflowAsTool}. `inputSchema` is the workflow's input shape (Zod). */
export interface WorkflowAsToolSpec<T extends ZodType> {
  /** Tool name surfaced to the LLM. Same constraints as a `CustomTool.name`. */
  name: string;
  /** Description surfaced to the LLM — when the agent should trigger the workflow. */
  description: string;
  /** Zod schema for the workflow's input (a `Workflow` carries no top-level schema). */
  inputSchema: T;
  /**
   * When `true`, a run that suspends returns `{"status":"suspended","runId":…,"stepId":…}` instead of
   * raising {@link WorkflowToolError}, so the model can hand the run id to a
   * {@link workflowResumeTool}. The report carries ids only, never the suspended payload; `stepId` is
   * `null` for a run that carries no step result. Default `false`.
   */
  reportSuspended?: boolean;
}

/** Spec for {@link workflowResumeTool}. */
export interface WorkflowResumeToolSpec {
  /** Tool name surfaced to the LLM. Same constraints as a `CustomTool.name`. */
  name: string;
  /** Description surfaced to the LLM — when the agent should resume a suspended run. */
  description: string;
  /** Report a run that suspends again instead of raising, as in {@link WorkflowAsToolSpec}. */
  reportSuspended?: boolean;
}

const resumeInputSchema = z.object({
  runId: z
    .string()
    .min(1)
    .describe('The runId from a {"status":"suspended"} report of the tool that started the run.'),
  payload: z
    .unknown()
    .optional()
    .describe("The payload the suspended step asks for; omit it when the step declares none."),
});

// The suspending step is always the last stepResults entry; `null` keeps the report at three keys
// for a run that carries none.
function toToolResult(run: WorkflowRun, toolName: string, reportSuspended: boolean): string {
  if (run.status === "suspended" && reportSuspended) {
    const stepId = run.stepResults.at(-1)?.stepId ?? null;
    return JSON.stringify({ status: "suspended", runId: run.id, stepId });
  }
  if (run.status !== "completed") {
    throw new WorkflowToolError(toolName, run.status, run.error);
  }
  const output = run.output;
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
}

/**
 * SE19 — expose a {@link Workflow} as an agent {@link CustomTool}, completing the
 * "X as tools" trio (tools; agents-as-tools via `defineSubAgent`; workflows-as-tools).
 * The handler validates the model's args against `spec.inputSchema`, runs the
 * workflow, and returns its output (a string as-is, else JSON). A run that does not
 * reach `status: "completed"` raises a typed {@link WorkflowToolError} (workflow
 * step errors do NOT throw — they surface via `run.status === "failed"`), except a
 * suspended run with `spec.reportSuspended`, which returns the suspended report.
 *
 * Accepts any `{ run }`-shaped workflow (structural), so it never imports the
 * `Workflow` class directly.
 *
 * @public
 */
export function workflowAsTool<T extends ZodType, TOutput = unknown>(
  workflow: { run: (input: z.infer<T>) => Promise<WorkflowRun<TOutput>> },
  spec: WorkflowAsToolSpec<T>,
): CustomTool {
  const inputSchema = toJsonSchema(spec.inputSchema, { unrepresentable: "any" });
  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    handler: async (rawInput: Record<string, unknown>): Promise<string> => {
      const parsed = spec.inputSchema.parse(rawInput) as z.infer<T>;
      const run = await workflow.run(parsed);
      return toToolResult(run, spec.name, spec.reportSuspended === true);
    },
  };
}

/**
 * B-677 — a {@link CustomTool} that resumes a suspended run of `workflow` by its run id, with an
 * optional payload validated against the suspend step's schema. It returns the run's output like
 * {@link workflowAsTool}; a run that suspends again keeps the same run id and is reported or raised
 * per `spec.reportSuspended`. Snapshot errors (`WorkflowSnapshotNotFoundError` for an unknown or
 * already-resumed id, `WorkflowResumeWorkflowMismatchError` for a run another workflow suspended,
 * `WorkflowResumeStepNotFoundError` when `workflow` lacks the suspended step) and payload validation
 * errors propagate to the dispatch.
 *
 * `workflow` must be the committed instance from `Workflow.create().commit()`. The default snapshot
 * store is in memory and process-local: a host that resumes across processes configures a persistent
 * backend. This tool resumes any run id it is given; deciding who may approve a run is the host's job.
 *
 * @public
 */
export function workflowResumeTool(
  workflow: WorkflowResumeOptions["workflow"],
  spec: WorkflowResumeToolSpec,
): CustomTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(resumeInputSchema, { unrepresentable: "any" }),
    handler: async (rawInput: Record<string, unknown>): Promise<string> => {
      const { runId, payload } = resumeInputSchema.parse(rawInput);
      // Dynamic import, as `Workflow.resume` does: a static one would close a file cycle through workflow.ts.
      const { resumeWorkflow } = await import("./internal/workflow/executor.js");
      const run = await resumeWorkflow({ runId, workflow, payload });
      return toToolResult(run, spec.name, spec.reportSuspended === true);
    },
  };
}
