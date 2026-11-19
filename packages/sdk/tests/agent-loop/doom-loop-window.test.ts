/** #1031 — sliding-window repeat limit of the doom-loop guard (alternating calls). */
import { describe, expect, it } from "vitest";
import { assertValidDoomLoopWindow } from "../../src/internal/agent-loop/doom-loop-tracker.js";
import { runAgentLoop } from "../../src/internal/agent-loop/loop.js";
import type { AgentLoopInputs } from "../../src/internal/agent-loop/types.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "../../src/internal/llm/types.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";

type Call = Record<string, unknown>;

/** One tool call per turn from `script`, then a final text turn. Records the last request. */
function fixture(script: Call[]) {
  const executed: Call[] = [];
  const requests: LlmRequest[] = [];
  let turn = 0;
  const llm: LlmClient = {
    name: "mock",
    async *stream(request): AsyncGenerator<LlmEvent, LlmFinish, void> {
      requests.push(request);
      yield { type: "text_delta", text: "" };
      const input = script[turn];
      turn += 1;
      if (input === undefined) {
        return {
          stopReason: "end_turn",
          text: "done",
          toolCalls: [],
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      const toolCalls = [{ type: "tool_use" as const, id: `c${turn}`, name: "read", input }];
      return { stopReason: "tool_use", text: "", toolCalls, inputTokens: 1, outputTokens: 1 };
    },
  };
  const inputs = (doomLoop?: AgentLoopInputs["doomLoop"]): AgentLoopInputs => ({
    agentId: "w",
    runId: "r",
    userMessage: "go",
    model: { id: "m" },
    llm,
    mcp: new Map(),
    hooks: new HooksExecutor(process.cwd()),
    shellCwd: process.cwd(),
    shellSandbox: false,
    maxIterations: 40,
    customTools: [
      {
        name: "read",
        description: "read",
        inputSchema: { type: "object" },
        handler: (i: Call) => {
          executed.push(i);
          return `contents:${JSON.stringify(i)}`;
        },
      },
    ],
    ...(doomLoop !== undefined ? { doomLoop } : {}),
  });
  return { inputs, executed, requests };
}

const alternating = (n: number): Call[] =>
  Array.from({ length: n }, (_, i) => ({ p: i % 2 === 0 ? "A" : "B" }));

describe("doom-loop sliding window (#1031)", () => {
  it("defaults do not stop an alternating A/B loop", async () => {
    const f = fixture(alternating(8));
    const out = await runAgentLoop(f.inputs());
    expect(out.stoppedByDoomLoop).not.toBe(true);
    expect(f.executed).toHaveLength(8);
  });

  it("blocks the 4th read(A) and tells the model", async () => {
    const f = fixture(alternating(8));
    await runAgentLoop(f.inputs({ window: 20, windowRepeatLimit: 3 }));
    // A at calls 1,3,5 run; the 4th A (call 7) is blocked; B at 2,4,6,8: the 4th B is blocked too.
    expect(f.executed.filter((c) => c.p === "A")).toHaveLength(3);
    const last = JSON.stringify(f.requests[f.requests.length - 1]?.messages);
    expect(last).toContain("Blocked: `read`");
  });

  it("treats key order as irrelevant", async () => {
    const f = fixture([
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ]);
    await runAgentLoop(f.inputs({ window: 10, windowRepeatLimit: 2 }));
    expect(f.executed).toHaveLength(2);
  });

  it("forgets calls that slid out of the window", async () => {
    const f = fixture([{ p: "A" }, { p: "B" }, { p: "C" }, { p: "D" }, { p: "A" }]);
    await runAgentLoop(f.inputs({ window: 3, windowRepeatLimit: 1 }));
    expect(f.executed).toHaveLength(5);
  });

  it("rejects an unpaired or non-positive window", () => {
    for (const bad of [
      { window: 10 },
      { windowRepeatLimit: 3 },
      { window: 0, windowRepeatLimit: 1 },
    ]) {
      expect(() => assertValidDoomLoopWindow(bad)).toThrowError(
        expect.objectContaining({ code: "invalid_doom_loop" }),
      );
    }
    expect(() => assertValidDoomLoopWindow({ window: 5, windowRepeatLimit: 2 })).not.toThrow();
  });
});
