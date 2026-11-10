import { describe, expect, it } from "vitest";

import { dispatchTools } from "../../src/internal/agent-loop/tool-dispatch.js";
import type { AgentLoopInputs, ResolvedTool } from "../../src/internal/agent-loop/types.js";
import type { LlmToolCallPart } from "../../src/internal/llm/types.js";
import type { McpClient } from "../../src/internal/mcp/client.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";

/** Fake server: `first` resolves after `second` would; the log records start/end order. */
function fakeServer(name: string, log: string[], sequential: boolean): McpClient {
  return {
    name,
    ...(sequential ? { sequential: true } : {}),
    initialize: async () => {},
    listTools: async () => [],
    close: async () => {},
    callTool: async (tool) => {
      log.push(`start:${name}.${tool}`);
      await new Promise((r) => setTimeout(r, tool === "first" ? 40 : 1));
      log.push(`end:${name}.${tool}`);
      return { content: [{ type: "text", text: `${name}.${tool}` }] };
    },
  };
}

function mcpTool(server: string, tool: string, sequential: boolean): ResolvedTool {
  return {
    name: `mcp_${server}_${tool}`,
    description: tool,
    inputSchema: { type: "object" },
    origin: "mcp",
    mcpServerName: server,
    mcpToolName: tool,
    ...(sequential ? { mcpSequential: true } : {}),
  };
}

async function run(sequential: boolean): Promise<{ log: string[]; contents: unknown[] }> {
  const log: string[] = [];
  const mcp = new Map<string, McpClient>([
    ["a", fakeServer("a", log, sequential)],
    ["b", fakeServer("b", log, false)],
  ]);
  const inputs = {
    agentId: "x",
    runId: "r",
    userMessage: "go",
    model: { id: "m" },
    mcp,
    hooks: new HooksExecutor(process.cwd()),
    shellCwd: process.cwd(),
    shellSandbox: false,
    maxIterations: 2,
  } as unknown as AgentLoopInputs;
  const tools = [
    mcpTool("a", "first", sequential),
    mcpTool("a", "second", sequential),
    mcpTool("b", "first", false),
  ];
  const calls: LlmToolCallPart[] = [
    { type: "tool_use", id: "1", name: "mcp_a_first", input: {} },
    { type: "tool_use", id: "2", name: "mcp_a_second", input: {} },
    { type: "tool_use", id: "3", name: "mcp_b_first", input: {} },
  ];
  const parts = await dispatchTools(inputs, tools, calls, []);
  return { log, contents: parts.map((p) => (p as { content: unknown }).content) };
}

describe("sequential MCP server (#932)", () => {
  it("runs one server's calls in order, keeps call order, and does not hold other servers", async () => {
    const { log, contents } = await run(true);
    expect(log.indexOf("start:a.second")).toBeGreaterThan(log.indexOf("end:a.first"));
    expect(log.indexOf("start:b.first")).toBeLessThan(log.indexOf("end:a.first"));
    expect(contents.map(String)).toEqual([
      expect.stringContaining("a.first"),
      expect.stringContaining("a.second"),
      expect.stringContaining("b.first"),
    ]);
  });

  it("without the option both calls run at once", async () => {
    const { log } = await run(false);
    expect(log.indexOf("start:a.second")).toBeLessThan(log.indexOf("end:a.first"));
  });
});
