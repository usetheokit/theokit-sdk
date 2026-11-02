import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { runAgentLoop } from "../../src/internal/agent-loop/loop.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmRequest,
  LlmToolCallPart,
  LlmToolResultPart,
} from "../../src/internal/llm/types.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";
import {
  __resetSnapshotStoresForTests,
  fn,
  Workflow,
  workflowAsTool,
  workflowResumeTool,
} from "../../src/workflow.js";

/**
 * B-677 review F-wire-2 — the start and resume tools registered on an agent loop, driven by a
 * scripted model: the model reads the suspended report the dispatch hands back, resumes by its run
 * id, then resumes the same id again, and the dispatch turns the second resume's
 * `WorkflowSnapshotNotFoundError` into an `isError` tool result instead of failing the run.
 */
describe("workflowAsTool + workflowResumeTool through the agent dispatch (B-677)", () => {
  afterEach(() => __resetSnapshotStoresForTests());

  function lastToolResult(request: LlmRequest): LlmToolResultPart {
    const parts = request.messages.flatMap((message) => message.content);
    const results = parts.filter((part): part is LlmToolResultPart => part.type === "tool_result");
    const last = results.at(-1);
    if (last === undefined) throw new Error("the scripted model expected a tool result");
    return last;
  }

  /** Turn 1 starts the run; each later turn derives its call from the previous tool result. */
  function scriptedModel(seen: LlmToolResultPart[]): LlmClient {
    let turn = 0;
    const toolUse = (calls: LlmToolCallPart[]): LlmFinish => ({
      stopReason: "tool_use",
      text: "",
      toolCalls: calls,
      inputTokens: 1,
      outputTokens: 1,
    });
    return {
      name: "scripted",
      async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
        yield { type: "text_delta", text: "" };
        turn += 1;
        if (turn === 1) {
          return toolUse([{ type: "tool_use", id: "c1", name: "pay", input: { amount: 10 } }]);
        }
        const result = lastToolResult(request);
        seen.push(result);
        if (turn === 2 || turn === 3) {
          const runId = JSON.parse(String(seen[0]?.content)).runId as string;
          const input = { runId, payload: { approved: true } };
          return toolUse([{ type: "tool_use", id: `c${turn}`, name: "approve_payment", input }]);
        }
        return {
          stopReason: "end_turn",
          text: "done",
          toolCalls: [],
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
  }

  it("dispatches_start_then_resume_and_returns_a_stale_resume_as_an_error_result", async () => {
    const workflow = Workflow.create({ name: "resume-tool-agent" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "approve", payloadSchema: z.object({ approved: z.boolean() }) })
      .then(fn<unknown, string>("pay", async (input) => `paid with ${JSON.stringify(input)}`))
      .commit();
    const seen: LlmToolResultPart[] = [];

    const output = await runAgentLoop({
      agentId: "b677",
      runId: "agent-run-1",
      userMessage: "pay 10 after approval",
      model: { id: "scripted-model" },
      llm: scriptedModel(seen),
      mcp: new Map(),
      hooks: new HooksExecutor(process.cwd()),
      shellCwd: process.cwd(),
      shellSandbox: false,
      maxIterations: 6,
      customTools: [
        workflowAsTool(workflow, {
          name: "pay",
          description: "Pays after approval",
          inputSchema: z.object({ amount: z.number() }),
          reportSuspended: true,
        }),
        workflowResumeTool(workflow, {
          name: "approve_payment",
          description: "Approves a suspended payment",
        }),
      ],
    });

    const report = JSON.parse(String(seen[0]?.content));
    expect(report).toEqual({ status: "suspended", runId: report.runId, stepId: "approve" });
    expect(seen[1]).toMatchObject({ content: 'paid with {"approved":true}' });
    expect(seen[1]?.isError).not.toBe(true);
    expect(seen[2]).toMatchObject({ isError: true });
    expect(String(seen[2]?.content)).toContain(report.runId);
    expect(output.finalStatus).toBe("finished");
  });
});
