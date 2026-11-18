import type { ToolContextMessage } from "../../types/agent-prims.js";
import type { DeferredToolCall } from "../../types/run.js";
import type { LlmContentPart, LlmMessage, LlmToolCallPart } from "../llm/types.js";
import { safeCall } from "../runtime/system-prompt/safe-call.js";
import type { LoopContext } from "./loop-context-init.js";
import { applyToolResultGuard } from "./tool-result-guard.js";
import type { AgentLoopInputs } from "./types.js";

/**
 * SE12 — flatten the running transcript to the read-only text projection tool
 * handlers receive on `ctx.messages`. Non-text parts (tool calls / results) are
 * dropped so a tool never sees raw wire parts or nested tool args.
 */
export function projectToolContextMessages(messages: readonly LlmMessage[]): ToolContextMessage[] {
  const projected: ToolContextMessage[] = [];
  for (const m of messages) {
    const content = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    // Skip turns that project to empty text (a tool-only assistant turn or a
    // tool-result-only user turn) — the text projection has nothing to forward,
    // so a messageFilter never sees zero-content noise.
    if (content !== "") projected.push({ role: m.role, content });
  }
  return projected;
}

/**
 * Build the ordered `toolCall` (+ paired `toolResult`) steps for a tool-using turn. Shared by the
 * live `onStep` emission and the `Run.conversation()` accumulation so the two surfaces never drift
 * (#SE39 — onStep previously emitted `toolCall` but dropped `toolResult`; both now use this).
 */
export function buildToolSteps(
  calls: LlmToolCallPart[],
  results: LlmContentPart[],
): import("../../types/conversation.js").ConversationStep[] {
  const steps: import("../../types/conversation.js").ConversationStep[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call === undefined) continue;
    steps.push({
      type: "toolCall",
      message: { callId: call.id, name: call.name, args: call.input },
    });
    const result = results[i];
    if (result?.type === "tool_result") {
      steps.push({
        type: "toolResult",
        message: {
          callId: result.toolUseId ?? call.id,
          name: call.name,
          result:
            typeof result.content === "string" ? result.content : JSON.stringify(result.content),
          isError: result.isError === true,
        },
      });
    }
  }
  return steps;
}

/**
 * #57/#65 — built-in tool-result guard then the transform_tool_result hook fold.
 *
 * M82 — `toolCalls` is threaded into the hook context. The data was already in the caller's scope
 * (`llmOutput.toolCalls`) and was simply dropped, which left this seam — the ONLY tool-stage channel
 * whose return value the SDK applies — unable to say which tool produced which result. A scoped
 * policy therefore had to sit on `post_tool_call`, whose return is discarded, and silently degraded
 * to observation. Plural because the seam is batch-shaped; correlate by `toolUseId === id`.
 */
export async function guardAndTransformToolResults(
  inputs: AgentLoopInputs,
  raw: LlmContentPart[],
  ctx: { agentId: string; runId: string },
  toolCalls: readonly LlmToolCallPart[],
): Promise<LlmContentPart[]> {
  const guarded =
    inputs.toolResultGuard !== undefined ? applyToolResultGuard(raw, inputs.toolResultGuard) : raw;
  return inputs.pluginManager !== undefined
    ? inputs.pluginManager.runTransformToolResultHooks(guarded, {
        ...ctx,
        toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.input })),
      })
    : guarded;
}

/**
 * A gate deferred one or more calls: the other calls of the step have finished, so record them, keep
 * the deferred calls unanswered, and end the run as `deferred`. The transcript then ends on the
 * assistant message holding the unanswered `tool_use`.
 */
export async function endRunOnDeferredCalls(args: {
  readonly inputs: AgentLoopInputs;
  readonly ctx: LoopContext;
  readonly calls: LlmToolCallPart[];
  readonly rawResults: LlmContentPart[];
  readonly deferred: readonly DeferredToolCall[];
}): Promise<"done"> {
  const { inputs, ctx, calls, rawResults, deferred } = args;
  const pending = new Set(deferred.map((d) => d.toolUseId));
  const answered = calls
    .map((call, i) => ({ call, result: rawResults[i] }))
    .filter(
      (pair): pair is { call: LlmToolCallPart; result: LlmContentPart } =>
        pair.result !== undefined && !pending.has(pair.call.id),
    );
  const answeredCalls = answered.map((a) => a.call);
  const answeredResults = await guardAndTransformToolResults(
    inputs,
    answered.map((a) => a.result),
    { agentId: inputs.agentId, runId: inputs.runId },
    answeredCalls,
  );
  // Every call is recorded as a `toolCall` step; only the answered ones get a `toolResult`. A
  // deferred call is recorded as the call that was DEFERRED (repaired name and input, as the gate
  // saw them), so the transcript shows what the person is asked to approve. It stays pending while
  // no `tool_result` carries its id.
  const steps = [
    ...buildToolSteps(answeredCalls, answeredResults),
    ...deferred.map((d) => ({
      type: "toolCall" as const,
      message: { callId: d.toolUseId, name: d.toolName, args: d.input },
    })),
  ];
  ctx.conversation.push({ type: "agentConversationTurn", turn: { steps } });
  if (inputs.onStep !== undefined) {
    const cb = inputs.onStep;
    for (const step of steps) await safeCall(() => cb({ step }), undefined, "SendOptions.onStep");
  }
  ctx.deferredToolCalls = deferred;
  ctx.finalStatus = "deferred";
  return "done";
}
