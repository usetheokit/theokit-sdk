import { describe, expect, it } from "vitest";
import { dispatchTools, type ResolvedTool } from "../../src/internal/agent-loop/tool-dispatch.js";
import type { AgentLoopInputs } from "../../src/internal/agent-loop/types.js";
import type { SDKMessage, SDKToolUseMessage } from "../../src/types/messages.js";

function tool(name: string, handler: () => string): ResolvedTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    origin: "custom",
    customHandler: handler,
  };
}

async function run(
  tools: ResolvedTool[],
  name: string,
  veto?: string,
): Promise<SDKToolUseMessage | undefined> {
  const inputs = {
    agentId: "a-1",
    hooks: { run: async () => ({}) },
    runId: "r-1",
    ...(veto === undefined
      ? {}
      : { pluginManager: { runPreToolCallHooks: async () => ({ message: veto }) } }),
  } as unknown as AgentLoopInputs;
  const events: SDKMessage[] = [];
  await dispatchTools(inputs, tools, [{ type: "tool_use", id: "c-1", name, input: {} }], events);
  return events.find(
    (e): e is SDKToolUseMessage => e.type === "tool_call" && e.status !== "running",
  );
}

describe("finished tool_call status follows exitCode (#1072)", () => {
  it("a throwing handler is status error, exitCode 1", async () => {
    const boom = tool("boom", () => {
      throw new Error("nope");
    });
    const done = await run([boom], "boom");
    expect(done?.status).toBe("error");
    expect((done?.result as { exitCode: number }).exitCode).toBe(1);
  });

  it("a plugin veto is status error, exitCode 126", async () => {
    const done = await run([tool("ok", () => "fine")], "ok", "denied");
    expect(done?.status).toBe("error");
    expect((done?.result as { exitCode: number }).exitCode).toBe(126);
  });

  it("an unknown tool is status error, exitCode 127", async () => {
    const done = await run([], "missing");
    expect(done?.status).toBe("error");
    expect((done?.result as { exitCode: number }).exitCode).toBe(127);
  });

  it("a successful call stays completed, exitCode 0", async () => {
    const done = await run([tool("ok", () => "fine")], "ok");
    expect(done?.status).toBe("completed");
    expect((done?.result as { exitCode: number }).exitCode).toBe(0);
  });
});
