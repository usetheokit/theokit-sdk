import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { runAgentLoop } from "../../../src/internal/agent-loop/loop.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmRequest,
} from "../../../src/internal/llm/types.js";
import { HooksExecutor } from "../../../src/internal/runtime/hooks/hooks-executor.js";
import { removeTempDirRobust } from "../../helpers/temp-workspace.js";

/**
 * Behaviour gate for the real agent loop. Uses a stub LLM client that
 * schedules a tool_use turn followed by a final text turn, plus the real
 * shell tool against a tmp workspace. Proves end-to-end orchestration:
 * system event → user event → tool_call running/completed → assistant text.
 */

function buildStubClient(plan: Array<LlmFinish>): LlmClient {
  let cursor = 0;
  return {
    name: "stub",
    async *stream(
      _request: LlmRequest,
      _signal: AbortSignal,
    ): AsyncGenerator<LlmEvent, LlmFinish, void> {
      const next = plan[cursor++];
      if (next === undefined) {
        return { stopReason: "end_turn", text: "", toolCalls: [] };
      }
      if (next.text.length > 0) yield { type: "text_delta", text: next.text };
      // theokit#144: tool calls travel on the finish value, which is what the loop reads. The stub
      // used to also yield them as `tool_use` events; nothing consumed those, so mirroring a real
      // provider means not emitting them.
      return next;
    },
  };
}

describe("real agent loop", () => {
  let cwd: string | undefined;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-loop-"));
    const __cwdCleanup1 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup1);
    });
    await writeFile(join(cwd, "data.txt"), "answer-is-42\n");
  });
  afterEach(() => {
    cwd = undefined;
  });

  it("drives an LLM → shell → LLM cycle and emits real tool output", async () => {
    if (cwd === undefined) throw new Error("missing workspace");
    const stub = buildStubClient([
      {
        stopReason: "tool_use",
        text: "Let me check the file.",
        toolCalls: [
          {
            type: "tool_use",
            id: "call_1",
            name: "shell",
            input: { command: "cat data.txt" },
          },
        ],
      },
      {
        stopReason: "end_turn",
        text: "The file says: answer-is-42",
        toolCalls: [],
      },
    ]);
    const hooks = new HooksExecutor(cwd);
    await hooks.initialize(false);

    const result = await runAgentLoop({
      agentId: "agent-test",
      runId: "run-test",
      model: { id: "stub-model" },
      userMessage: "Read data.txt and report the answer",
      llm: stub,
      mcp: new Map(),
      hooks,
      shellCwd: cwd,
      shellSandbox: false,
    });

    expect(result.finalStatus).toBe("finished");
    expect(result.result).toContain("answer-is-42");
    const toolCallEvents = result.events.filter((event) => event.type === "tool_call");
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    const completed = toolCallEvents.find(
      (event) => event.type === "tool_call" && event.status === "completed",
    );
    expect(completed).toBeDefined();
    if (completed?.type === "tool_call") {
      const stdout = (completed.result as { stdout?: string } | undefined)?.stdout ?? "";
      expect(stdout).toContain("answer-is-42");
    }
  });

  it("aborts the loop when preToolUse hook denies", async () => {
    if (cwd === undefined) throw new Error("missing workspace");
    const stub = buildStubClient([
      {
        stopReason: "tool_use",
        text: "",
        toolCalls: [
          {
            type: "tool_use",
            id: "call_1",
            name: "shell",
            input: { command: "rm -rf /etc/passwd" },
          },
        ],
      },
    ]);
    await writeFile(join(cwd, ".theokit-hooks.json"), JSON.stringify({ hooks: {} }));
    const hooks = new HooksExecutor(cwd);
    await hooks.initialize(false);
    // Inline policy: prove the loop respects hook denial. We construct a
    // hooks executor that always denies preToolUse by overriding `run`.
    const denyingHooks = {
      initialize: () => Promise.resolve(),
      run: () => Promise.resolve({ decisions: [], blocked: true, reason: "policy" }),
    } as unknown as HooksExecutor;

    const result = await runAgentLoop({
      agentId: "agent-test",
      runId: "run-test",
      model: { id: "stub-model" },
      userMessage: "Run dangerous command",
      llm: stub,
      mcp: new Map(),
      hooks: denyingHooks,
      shellCwd: cwd,
      shellSandbox: false,
      maxIterations: 1,
    });

    const completed = result.events.find(
      (event) => event.type === "tool_call" && event.status === "error",
    );
    expect(completed).toBeDefined();
    if (completed?.type === "tool_call") {
      const exit = (completed.result as { exitCode?: number } | undefined)?.exitCode;
      expect(exit).toBe(126);
    }
  });
});
