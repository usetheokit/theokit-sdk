import type { ConversationStep } from "../../types/conversation.js";
import type { DeferredToolCall } from "../../types/run.js";
import type { LlmContentPart, LlmToolCallPart } from "../llm/types.js";
import { safeCall } from "../runtime/system-prompt/safe-call.js";
import type { LoopContext } from "./loop-context-init.js";
import { guardAndTransformToolResults, projectToolContextMessages } from "./loop-tool-steps.js";
import { dispatchTools } from "./tool-dispatch.js";
import type { AgentLoopInputs } from "./types.js";

/**
 * Answer the tool calls a previous run deferred, before the model's next turn.
 *
 * An `allow` decision dispatches the stored call through the normal path, so the permission plugin,
 * the floors and every other `pre_tool_call` hook run again on the stored input (the approval only
 * answers an `ask`). A `deny` decision writes an error result and runs nothing. The results join the
 * history as the user turn that follows the unanswered `tool_use` blocks.
 */
export async function applyResume(inputs: AgentLoopInputs, ctx: LoopContext): Promise<void> {
  const resume = inputs.resume;
  if (resume === undefined) return;
  const decisions = new Map(resume.decisions.map((d) => [d.toolUseId, d]));
  const calls = resume.calls.map(toToolCall);
  const allowed = calls.filter((c) => decisions.get(c.id)?.behavior === "allow");
  const deferredAgain: DeferredToolCall[] = [];
  const ran =
    allowed.length === 0
      ? []
      : await dispatchTools(
          { ...inputs, messages: projectToolContextMessages(ctx.messages) },
          ctx.tools,
          allowed,
          ctx.events,
          ctx.sendSpan,
          deferredAgain,
        );
  const raw: LlmContentPart[] = calls.map((call) => {
    const decision = decisions.get(call.id);
    if (decision?.behavior !== "allow") {
      return errorResult(call.id, decision?.message ?? `denied: ${call.name}`);
    }
    const result = ran[allowed.indexOf(call)] as LlmContentPart;
    return deferredAgain.some((d) => d.toolUseId === call.id)
      ? errorResult(call.id, `${call.name} was deferred again; a resumed call cannot be deferred`)
      : result;
  });
  const results = await guardAndTransformToolResults(
    inputs,
    raw,
    { agentId: inputs.agentId, runId: inputs.runId },
    calls,
  );
  appendResults(ctx, results);
  await recordResultSteps(inputs, ctx, calls, results);
}

function toToolCall(call: DeferredToolCall): LlmToolCallPart {
  return { type: "tool_use", id: call.toolUseId, name: call.toolName, input: call.input };
}

function errorResult(toolUseId: string, content: string): LlmContentPart {
  return { type: "tool_result", toolUseId, content, isError: true };
}

/** Join the stored siblings' results when the history ends on them (one user turn), else add a turn. */
function appendResults(ctx: LoopContext, results: LlmContentPart[]): void {
  const last = ctx.messages[ctx.messages.length - 1];
  if (last?.role === "user" && last.content.every((p) => p.type === "tool_result")) {
    ctx.messages[ctx.messages.length - 1] = {
      role: "user",
      content: [...last.content, ...results],
    };
    return;
  }
  ctx.messages.push({ role: "user", content: results });
}

/** Only `toolResult` steps: the `toolCall` steps are already in the stored transcript. */
async function recordResultSteps(
  inputs: AgentLoopInputs,
  ctx: LoopContext,
  calls: readonly LlmToolCallPart[],
  results: readonly LlmContentPart[],
): Promise<void> {
  const steps: ConversationStep[] = [];
  for (const [i, call] of calls.entries()) {
    const result = results[i];
    if (result?.type !== "tool_result") continue;
    steps.push({
      type: "toolResult",
      message: {
        callId: result.toolUseId,
        name: call.name,
        result:
          typeof result.content === "string" ? result.content : JSON.stringify(result.content),
        isError: result.isError === true,
      },
    });
  }
  ctx.conversation.push({ type: "agentConversationTurn", turn: { steps } });
  const cb = inputs.onStep;
  if (cb === undefined) return;
  for (const step of steps) await safeCall(() => cb({ step }), undefined, "SendOptions.onStep");
}
