/**
 * Pure helpers extracted from the workflow executor (G8 focus): run assembly,
 * abort, whole-workflow schema validation (SE27), and the shared-state
 * controller (SE29). No executor-internal dependencies — safe to import both ways.
 *
 * @internal
 */

import type { ZodType } from "zod";
import type {
  CompensationResult,
  StepResult,
  WorkflowOptions,
  WorkflowRun,
} from "../../types/workflow.js";
import { WorkflowStateError } from "../../workflow-errors.js";
import type { StateController } from "./ctx.js";

export interface AssembleParams<TO> {
  runId: string;
  name: string;
  status: WorkflowRun["status"];
  stepResults: ReadonlyArray<StepResult>;
  startedAt: number;
  output?: TO;
  error?: { name: string; message: string };
  compensation?: ReadonlyArray<CompensationResult>;
}

export function assembleRun<TO>(params: AssembleParams<TO>): WorkflowRun<TO> {
  return {
    id: params.runId,
    name: params.name,
    status: params.status,
    startedAt: params.startedAt,
    endedAt: Date.now(),
    stepResults: params.stepResults,
    ...(params.output !== undefined ? { output: params.output } : {}),
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.compensation !== undefined ? { compensation: params.compensation } : {}),
  };
}

export function abortRun<T>(
  name: string,
  runId: string,
  startedAt: number,
  stepResults: StepResult[],
  signal: AbortSignal,
): WorkflowRun<T> {
  return assembleRun<T>({
    runId,
    name,
    status: "cancelled",
    stepResults,
    startedAt,
    error: { name: "AbortError", message: String(signal.reason ?? "Aborted") },
  });
}

/**
 * SE27 — validate a value against a whole-workflow schema. Returns a compact
 * issues string on failure, `undefined` when the schema is absent or matches.
 */
export function validateWorkflowSchema(
  schema: ZodType | undefined,
  value: unknown,
): string | undefined {
  if (schema === undefined) return undefined;
  let parsed: ReturnType<ZodType["safeParse"]>;
  try {
    parsed = schema.safeParse(value);
  } catch {
    // A schema with an async refinement throws synchronously from safeParse
    // ("Encountered Promise during synchronous parse"). Surface it as a
    // validation issue (→ status:"failed") instead of escaping run() (never-throw).
    return "schema uses async refinements, which whole-workflow validation does not support (use a synchronous Zod schema)";
  }
  if (parsed.success) return undefined;
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** SE29 — the per-run shared-state holder; `setState` validates against `stateSchema`. */
export function makeStateController(options: WorkflowOptions, initial: unknown): StateController {
  let current = initial;
  return {
    getState: () => current,
    setState: (next: unknown) => {
      const issues = validateWorkflowSchema(options.stateSchema, next);
      if (issues !== undefined) throw new WorkflowStateError(options.name, issues);
      current = next;
    },
  };
}
