/**
 * A linear workflow described as data, and the loader for a directory of them.
 *
 * One JSON object per `.json` file:
 *
 * ```json
 * { "name": "release", "steps": [{ "id": "draft", "prompt": "Draft notes" }, { "id": "ok", "approve": true }] }
 * ```
 *
 * A step is `{ id, prompt }` (calls the `generate` callback of `Workflow.fromDefinition`) or
 * `{ id, approve: true }` (suspends until `Workflow.resume`). Ids use the step-id grammar
 * `^[a-z0-9][a-z0-9_-]*$` and are unique within the workflow.
 *
 * @public
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const StepIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must match ^[a-z0-9][a-z0-9_-]*$");

const PromptStepSchema = z.object({ id: StepIdSchema, prompt: z.string().min(1) }).strict();
const ApproveStepSchema = z.object({ id: StepIdSchema, approve: z.literal(true) }).strict();

export const WorkflowDefinitionSchema = z
  .object({
    name: z.string().min(1).max(128),
    steps: z.array(z.union([PromptStepSchema, ApproveStepSchema])).min(1),
  })
  .strict()
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    def.steps.forEach((step, i) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "id"],
          message: `duplicate step id "${step.id}"`,
        });
      }
      seen.add(step.id);
    });
  });

/** A prompt step: calls `generate(prompt, ...)` with the previous step's value. @public */
export interface WorkflowPromptStepDefinition {
  readonly id: string;
  readonly prompt: string;
}
/** An approval step: suspends the run until `Workflow.resume`. @public */
export interface WorkflowApprovalStepDefinition {
  readonly id: string;
  readonly approve: true;
}
/** A linear workflow as data. @public */
export interface WorkflowDefinition {
  readonly name: string;
  readonly steps: ReadonlyArray<WorkflowPromptStepDefinition | WorkflowApprovalStepDefinition>;
}

/**
 * Thrown for a definition that is not valid. `file` is set when it came from a directory; `field` is
 * the dotted path of the offending field (for example `steps.1.id`), or `""` for the whole document.
 *
 * @public
 */
export class WorkflowDefinitionError extends ConfigurationError {
  override readonly name = "WorkflowDefinitionError";
  constructor(
    public readonly file: string | undefined,
    public readonly field: string,
    public readonly detail: string,
  ) {
    super(
      `Invalid workflow definition${file !== undefined ? ` in ${file}` : ""}${field !== "" ? ` at "${field}"` : ""}: ${detail}`,
      { code: "workflow_definition_invalid" },
    );
  }
}

/** Validate `input` as a {@link WorkflowDefinition}; throws {@link WorkflowDefinitionError}. @public */
export function parseWorkflowDefinition(input: unknown, file?: string): WorkflowDefinition {
  const result = WorkflowDefinitionSchema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = (issue?.path ?? []).join(".");
  throw new WorkflowDefinitionError(file, field, issue?.message ?? "invalid");
}

/** Read and validate one `.json` definition file in `dir`; errors name `file`. @internal */
export async function readDefinitionFile(dir: string, file: string): Promise<WorkflowDefinition> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(join(dir, file), "utf8"));
  } catch (cause) {
    throw new WorkflowDefinitionError(file, "", `not valid JSON: ${(cause as Error).message}`);
  }
  return parseWorkflowDefinition(json, file);
}

/** The `*.json` file names directly in `dir`, in filename order. @internal */
export async function listDefinitionFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort((a, b) => a.localeCompare(b, "en"));
}
