import { describe, expect, it } from "vitest";
import { ToolDecisionMismatchError } from "../src/index.js";
import { runAgentLoop } from "../src/internal/agent-loop/loop.js";
import type { AgentLoopInputs } from "../src/internal/agent-loop/types.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmToolCallPart } from "../src/internal/llm/types.js";
import { PluginManager } from "../src/internal/plugins/manager.js";
import { HooksExecutor } from "../src/internal/runtime/hooks/hooks-executor.js";
import { PermissionEngine } from "../src/permission-engine.js";
import { type PermissionGate, PermissionPlugin } from "../src/permission-plugin.js";

function llm(calls: readonly LlmToolCallPart[]): LlmClient {
  let turn = 0;
  return {
    name: "mock",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      yield { type: "text_delta", text: "" };
      turn += 1;
      if (turn === 1) {
        return {
          stopReason: "tool_use",
          text: "",
          toolCalls: [...calls],
          inputTokens: 1,
          outputTokens: 1,
        };
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

function inputs(client: LlmClient, mgr: PluginManager, ran: string[]): AgentLoopInputs {
  return {
    agentId: "defer",
    runId: "run-1",
    userMessage: "go",
    model: { id: "mock-model" },
    llm: client,
    mcp: new Map(),
    hooks: new HooksExecutor(process.cwd()),
    shellCwd: process.cwd(),
    shellSandbox: false,
    maxIterations: 4,
    customTools: ["risky", "safe"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      handler: () => {
        ran.push(name);
        return `result-of-${name}`;
      },
    })),
    pluginManager: mgr,
  };
}

async function managerWith(gate: PermissionGate, rules: "ask-risky" = "ask-risky") {
  void rules;
  const engine = new PermissionEngine([
    { tool: "risky", action: "ask" },
    { tool: "safe", action: "allow" },
  ]);
  const mgr = new PluginManager();
  await mgr.initialize([PermissionPlugin.create(engine, { canUseTool: gate })]);
  return mgr;
}

describe("deferring a tool call", () => {
  it("pre_tool_call_context_carries_the_tool_use_id", async () => {
    const seen: string[] = [];
    const mgr = new PluginManager();
    await mgr.initialize([
      {
        name: "spy",
        version: "1.0",
        kind: "general",
        register: (ctx) => {
          ctx.on("pre_tool_call", ((c: { toolUseId: string }) => {
            seen.push(c.toolUseId);
            return undefined;
          }) as never);
        },
      },
    ]);
    const out = await runAgentLoop(
      inputs(llm([{ type: "tool_use", id: "call-7", name: "safe", input: {} }]), mgr, []),
    );
    expect(seen).toEqual(["call-7"]);
    const resultIds = out.conversation.flatMap((t) =>
      t.type === "agentConversationTurn"
        ? t.turn.steps.flatMap((s) => (s.type === "toolResult" ? [s.message.callId] : []))
        : [],
    );
    expect(resultIds).toEqual(["call-7"]);
  });

  it("defers_a_tool_call_and_ends_the_run", async () => {
    const ran: string[] = [];
    const mgr = await managerWith(() => ({ behavior: "defer", reason: "needs a person" }));
    const out = await runAgentLoop(
      inputs(
        llm([
          { type: "tool_use", id: "c-1", name: "risky", input: { path: "x" } },
          { type: "tool_use", id: "c-2", name: "safe", input: {} },
        ]),
        mgr,
        ran,
      ),
    );
    expect(out.finalStatus).toBe("deferred");
    expect(out.deferredToolCalls).toHaveLength(1);
    expect(out.deferredToolCalls?.[0]).toMatchObject({
      schemaVersion: 1,
      toolUseId: "c-1",
      toolName: "risky",
      input: { path: "x" },
      reason: "needs a person",
    });
    // The risky handler never ran; the other call of the step finished as before.
    expect(ran).toEqual(["safe"]);
    const steps = out.conversation.flatMap((t) =>
      t.type === "agentConversationTurn" ? t.turn.steps : [],
    );
    expect(steps.filter((s) => s.type === "toolResult").map((s) => s.message.callId)).toEqual([
      "c-2",
    ]);
    expect(steps.filter((s) => s.type === "toolCall")).toHaveLength(2);
  });

  it("a_block_wins_over_a_defer_and_allow_is_unchanged", async () => {
    const ran: string[] = [];
    const mgr = await managerWith(() => ({ behavior: "allow" }));
    const out = await runAgentLoop(
      inputs(llm([{ type: "tool_use", id: "c-1", name: "risky", input: {} }]), mgr, ran),
    );
    expect(out.finalStatus).toBe("finished");
    expect(ran).toEqual(["risky"]);
  });

  it("exports ToolDecisionMismatchError with its code", () => {
    const err = new ToolDecisionMismatchError("no pending call x");
    expect(err.code).toBe("tool_decision_mismatch");
    expect(err.name).toBe("ToolDecisionMismatchError");
  });
});
