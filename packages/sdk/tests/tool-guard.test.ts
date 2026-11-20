import { describe, expect, it, vi } from "vitest";

import { guardTools, runPreToolCall, ToolCallBlockedError } from "../src/index.js";
import { runAgentLoop } from "../src/internal/agent-loop/loop.js";
import type { LlmClient, LlmEvent, LlmFinish } from "../src/internal/llm/types.js";
import { PluginManager } from "../src/internal/plugins/manager.js";
import type { Plugin, PreToolCallContext } from "../src/internal/plugins/types.js";
import { HooksExecutor } from "../src/internal/runtime/hooks/hooks-executor.js";
import type { CustomTool } from "../src/types/agent-prims.js";

type Handler = (ctx: PreToolCallContext) => unknown;

function plugin(name: string, handler: Handler): Plugin {
  return {
    name,
    version: "1.0",
    kind: "general",
    register: (ctx) => {
      ctx.on("pre_tool_call", handler as never);
    },
  };
}

const ctx: PreToolCallContext = { name: "t", args: { a: 1 }, agentId: "ag", runId: "r1" };

function tool(handler: CustomTool["handler"]): CustomTool {
  return { name: "t", description: "d", inputSchema: { type: "object" }, handler };
}

describe("runPreToolCall", () => {
  it("returns the first block and never calls later plugins", async () => {
    const third = vi.fn();
    const decision = await runPreToolCall(
      [
        plugin("a", () => undefined),
        plugin("b", () => ({ block: true, message: "no" })),
        plugin("c", third),
      ],
      ctx,
    );
    expect(decision).toEqual({ block: true, message: "no" });
    expect(third).not.toHaveBeenCalled();
  });

  it("returns undefined when all allow", async () => {
    expect(await runPreToolCall([plugin("a", () => undefined)], ctx)).toBeUndefined();
  });

  it("propagates a throwing handler", async () => {
    await expect(
      runPreToolCall(
        [
          plugin("a", () => {
            throw new Error("boom");
          }),
        ],
        ctx,
      ),
    ).rejects.toThrow("boom");
  });
});

describe("guardTools", () => {
  it("runs the handler with the original input and context when allowed", async () => {
    const handler = vi.fn(() => "ok");
    const seen: PreToolCallContext[] = [];
    const [wrapped] = guardTools(
      [tool(handler)],
      [
        plugin("a", (c) => {
          seen.push(c);
        }),
      ],
      { agentId: "ag", permissionMode: "plan" },
    );
    const toolCtx = { threadId: "th" };
    expect(await wrapped?.handler({ x: 1 }, toolCtx)).toBe("ok");
    expect(handler).toHaveBeenCalledWith({ x: 1 }, toolCtx);
    expect(wrapped?.name).toBe("t");
    expect(wrapped?.description).toBe("d");
    expect(seen[0]).toMatchObject({
      name: "t",
      args: { x: 1 },
      agentId: "ag",
      permissionMode: "plan",
    });
    expect(seen[0]?.runId).toBeTruthy();
  });

  it("uses the runId factory per call", async () => {
    const ids: string[] = [];
    let n = 0;
    const [wrapped] = guardTools([tool(() => "ok")], [plugin("a", (c) => void ids.push(c.runId))], {
      agentId: "ag",
      runId: () => `run-${++n}`,
    });
    await wrapped?.handler({});
    await wrapped?.handler({});
    expect(ids).toEqual(["run-1", "run-2"]);
  });

  it("rejects with ToolCallBlockedError and skips the handler on a veto", async () => {
    const handler = vi.fn(() => "ok");
    const [wrapped] = guardTools(
      [tool(handler)],
      [plugin("a", () => ({ block: true, message: "m" }))],
      { agentId: "ag" },
    );
    const err = await Promise.resolve(wrapped?.handler({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolCallBlockedError);
    expect((err as ToolCallBlockedError).toolName).toBe("t");
    expect((err as ToolCallBlockedError).pluginMessage).toBe("m");
    expect(handler).not.toHaveBeenCalled();
  });

  it("gives the same decision as the agent loop for the same plugin", async () => {
    const p = plugin("veto", () => ({ block: true, message: "nope" }));
    const handler = vi.fn(() => "ran");
    const [wrapped] = guardTools([tool(handler)], [p], { agentId: "ag" });
    const guarded = await Promise.resolve(wrapped?.handler({})).catch(
      (e: unknown) => e as ToolCallBlockedError,
    );

    let turn = 0;
    const llm: LlmClient = {
      name: "mock",
      async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
        yield { type: "text_delta", text: "" };
        turn += 1;
        const toolCalls =
          turn === 1 ? [{ type: "tool_use" as const, id: "c1", name: "t", input: {} }] : [];
        return {
          stopReason: turn === 1 ? "tool_use" : "end_turn",
          text: "",
          toolCalls,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const mgr = new PluginManager();
    await mgr.initialize([p]);
    const result = await runAgentLoop({
      agentId: "ag",
      runId: "r",
      userMessage: "go",
      model: { id: "m" },
      llm,
      mcp: new Map(),
      hooks: new HooksExecutor(process.cwd()),
      shellCwd: process.cwd(),
      shellSandbox: false,
      maxIterations: 4,
      customTools: [tool(handler)],
      pluginManager: mgr,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(guarded).toBeInstanceOf(ToolCallBlockedError);
    expect(JSON.stringify(result)).toContain((guarded as ToolCallBlockedError).message);
  });
});
