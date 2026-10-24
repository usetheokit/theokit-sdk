/**
 * SE37 — `reasoning: true` support internals: the CoT preamble + the
 * double-reasoning guard.
 *
 * A native reasoning model (configured with `model.params: [{ id: "thinking", value: "high" }]`)
 * already reasons internally, so layering the prompt-based `reasoning: true`
 * preamble + think tool on top wastes tokens and can degrade output. When a
 * native reasoning param is detected, `reasoning: true` is INERT (with a
 * one-time warn) — native reasoning wins.
 *
 * @internal
 */

import { z } from "zod";

import { Tool } from "../../../define-tool.js";
import type { CustomTool } from "../../../types/agent.js";
import type { ModelSelection } from "../../../types/agent-prims.js";
import { diag } from "../../diagnostics.js";

/**
 * Param ids that mean the model is doing its own (native) reasoning. Only ids the request builder
 * forwards as a reasoning effort belong here (`reasoningEffortFromParams` reads `thinking` only):
 * an id that switched `reasoning: true` off without being forwarded would leave the run with no
 * reasoning of any kind and no error.
 */
const NATIVE_REASONING_PARAM_IDS = new Set(["thinking"]);

/**
 * The CoT preamble prepended to the system prompt when `reasoning: true` is
 * active. Steers a non-reasoning model into a reason -> act -> observe loop and
 * self-validation via the `think` tool. Kept terse (bundle budget).
 */
export const REASONING_PREAMBLE =
  "Think step by step before answering: use the `think` tool to reason through each step, " +
  "validate your work, then answer. Reason about magnitude before comparing numbers.";

/**
 * The lean internal `think` scratchpad tool auto-attached by `reasoning: true`.
 * The richer public toolkit (`think` + `analyze`) ships from `@theokit/sdk-tools`
 * as `ReasoningTools.create()` — kept out of the core bundle. @internal
 */
export function createThinkTool(): CustomTool {
  return Tool.create({
    name: "think",
    description:
      "Scratchpad: reason through ONE step before answering. No side effects — your private " +
      "reasoning space. Call it repeatedly before the final answer.",
    inputSchema: z.object({ thought: z.string().min(1, "think: `thought` must be non-empty.") }),
    handler: ({ thought }) => thought,
  });
}

/**
 * True when the selected model is a native reasoning model — i.e. its `params`
 * carry a `thinking` param. A bare-string model or one without such a param
 * is NOT native (returns false), so `reasoning: true` applies to it.
 */
export function isNativeReasoning(model: ModelSelection | string | undefined): boolean {
  if (model === undefined || typeof model === "string") return false;
  const params = model.params;
  if (params === undefined) return false;
  return params.some((p) => NATIVE_REASONING_PARAM_IDS.has(p.id));
}

const warned = new Set<string>();

/**
 * Emit the "native reasoning detected, `reasoning: true` skipped" warning once
 * per process. Idempotent; safe to call from both the prompt-assembly and the
 * tool-attach paths without double-logging.
 *
 * @internal
 */
export function warnDoubleReasoningOnce(): void {
  if (warned.has("double-reasoning")) return;
  warned.add("double-reasoning");
  diag(
    "[theokit-sdk] `reasoning: true` skipped — a native reasoning model is configured " +
      "(model.params thinking); native reasoning wins. Remove one to silence.\n",
  );
}

/** Reset for tests; not exported via barrel. @internal */
export function _resetReasoningWarnForTests(): void {
  warned.clear();
}

/**
 * The effective decision: should `reasoning: true` inject the preamble + tool?
 * True only when the flag is on AND the model is not already reasoning natively.
 * Emits the one-time warn when suppressed by a native model.
 *
 * @internal
 */
export function reasoningActive(
  reasoning: boolean | undefined,
  model: ModelSelection | string | undefined,
): boolean {
  if (reasoning !== true) return false;
  if (isNativeReasoning(model)) {
    warnDoubleReasoningOnce();
    return false;
  }
  return true;
}
