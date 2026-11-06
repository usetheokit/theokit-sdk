/**
 * `structured_output` — hands the host the model's object only when it validates against the
 * consumer's zod schema.
 *
 * The model sees the schema as the tool's JSON Schema and calls the tool with its answer. The
 * handler runs the full zod contract (refinements and transforms included, which the JSON Schema
 * only approximates) and never throws: a failed parse becomes a typed result the model can act on.
 *
 * Return shape (always a JSON string):
 *   - `{ ok: true, output }` with `output` the parsed value, defaults and transforms applied
 *   - `{ ok: false, error: "invalid_structured_output", issue_count, issues }` with at most
 *     `maxIssues` issues, each `{ path, message }`, and `issue_count` the full count
 *
 * The tool does not end the agent turn: `CustomTool` has no terminal flag, so the host stops on
 * the first `ok: true` result.
 *
 * Limits, accepted and stated: "never throws" holds for synchronous schemas whose parsed value is
 * JSON-serialisable. An async refinement makes `safeParse` throw, and a transform that yields a
 * BigInt or a cycle makes the serialisation throw; both are the consumer's schema, and the error
 * surfaces as the tool error the SDK reports for any throwing handler.
 */

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import type { z } from "zod";

/** Default ceiling on the issues returned to the model. A default, not a measured limit. */
const DEFAULT_MAX_ISSUES = 10;

const DEFAULT_DESCRIPTION =
  "Return your final answer as an object matching this tool's input schema. " +
  "If the result reports invalid_structured_output, fix the listed issues and call again.";

/** Options for {@link createStructuredOutputTool}. `schema` is required and must describe an object. */
export interface CreateStructuredOutputToolOptions {
  /** The zod schema the model's object must satisfy. Its JSON Schema must have `type: "object"`. */
  schema: z.ZodType;
  /** Name exposed to the model. Omitted ⇒ `structured_output`. */
  name?: string;
  /** Description exposed to the model. Omitted ⇒ a literal telling the model to retry on issues. */
  description?: string;
  /** Most issues returned in one failure. Omitted ⇒ 10. */
  maxIssues?: number;
}

/** One validation issue: the dotted path to the field (empty for the root) and zod's message. */
export interface StructuredOutputIssue {
  path: string;
  message: string;
}

/** The tool's result, before it is serialised to the JSON string the handler returns. */
export type StructuredOutputResult =
  | { ok: true; output: unknown }
  | {
      ok: false;
      error: "invalid_structured_output";
      issue_count: number;
      issues: StructuredOutputIssue[];
    };

function requireMaxIssues(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `createStructuredOutputTool: maxIssues must be a positive integer, got ${value}`,
    );
  }
  return value;
}

function validate(schema: z.ZodType, input: unknown, maxIssues: number): StructuredOutputResult {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, output: parsed.data };
  const all = parsed.error.issues;
  return {
    ok: false,
    error: "invalid_structured_output",
    issue_count: all.length,
    issues: all.slice(0, maxIssues).map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

/**
 * Build a `structured_output` tool over `schema`.
 *
 * @throws TypeError when the schema's JSON Schema is not `type: "object"` (provider tool inputs
 *   must be objects; a top-level union, intersection or recursive `$ref` is refused too);
 *   RangeError when `maxIssues` is not a positive integer.
 */
export function createStructuredOutputTool(opts: CreateStructuredOutputToolOptions): CustomTool {
  const maxIssues = requireMaxIssues(opts.maxIssues ?? DEFAULT_MAX_ISSUES);
  const base = Tool.create({
    name: opts.name ?? "structured_output",
    description: opts.description ?? DEFAULT_DESCRIPTION,
    inputSchema: opts.schema,
    handler: () => "",
  });
  const type = (base.inputSchema as { type?: unknown }).type;
  if (type !== "object") {
    throw new TypeError(
      `createStructuredOutputTool: schema must be an object schema, got type ${String(type)}`,
    );
  }
  return {
    ...base,
    handler: (input: unknown) => JSON.stringify(validate(opts.schema, input, maxIssues)),
  };
}
