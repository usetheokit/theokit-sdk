/**
 * Forced MCP calls and name sanitization in the agent loop (follow-up to #1035).
 *
 * The catalog built from `listTools` is the only dispatch authority. Names the model sees are
 * sanitized (`mcp_<server>_<tool>`); the server always receives its own original tool name. A
 * forced call to a name outside the catalog (e.g. a tool omitted by an MCP filter) is refused and
 * never reaches `callTool`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  collectTools,
  mcpModelToolName,
} from "../../../src/internal/agent-loop/loop-context-init.js";
import { dispatchTools } from "../../../src/internal/agent-loop/tool-dispatch.js";
import type { AgentLoopInputs } from "../../../src/internal/agent-loop/types.js";
import type { McpClient } from "../../../src/internal/mcp/client.js";

function client(names: string[]) {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ran" }] });
  const c = {
    name: "srv",
    listTools: vi
      .fn()
      .mockResolvedValue(
        names.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
      ),
    callTool,
  } as unknown as McpClient;
  return { c, callTool };
}

async function dispatch(c: McpClient, toolName: string) {
  const mcp = new Map([["my.server", c]]);
  const tools = await collectTools(mcp, new Set());
  const inputs = {
    agentId: "a",
    runId: "r",
    mcp,
    hooks: { run: async () => ({ blocked: false }) },
  } as unknown as AgentLoopInputs;
  const [part] = await dispatchTools(
    inputs,
    tools,
    [{ type: "tool_use", id: "c1", name: toolName, input: {} }],
    [],
  );
  return JSON.stringify(part);
}

describe("name sanitization", () => {
  it("builds the model-facing name in one place", () => {
    expect(mcpModelToolName("my.server", "do/thing")).toMatch(
      /^mcp_my_server_[0-9a-f]{6}_do_thing_[0-9a-f]{6}$/,
    );
    expect(mcpModelToolName("srv", "plain-name")).toBe("mcp_srv_plain-name");
  });

  it("gives names that sanitize alike distinct model-facing names", () => {
    expect(mcpModelToolName("srv", "do/thing")).not.toBe(mcpModelToolName("srv", "do thing"));
    expect(mcpModelToolName("srv", "do/thing")).not.toBe(mcpModelToolName("srv", "do_thing"));
  });

  it("does not let a server/tool boundary shift collide names", () => {
    expect(mcpModelToolName("a_b", "c")).not.toBe(mcpModelToolName("a", "b_c"));
    expect(mcpModelToolName("a", "b_c")).toBe("mcp_a_b_c");
  });

  it("refuses a forced call to a filtered-out tool whose name collides across the boundary", async () => {
    const offered = client(["b_c"]);
    const mcp = new Map([["a", offered.c]]);
    const tools = await collectTools(mcp, new Set());
    const inputs = {
      agentId: "a",
      runId: "r",
      mcp,
      hooks: { run: async () => ({ blocked: false }) },
    } as unknown as AgentLoopInputs;
    const [part] = await dispatchTools(
      inputs,
      tools,
      [{ type: "tool_use", id: "c1", name: mcpModelToolName("a_b", "c"), input: {} }],
      [],
    );
    expect(JSON.stringify(part)).toContain("Unknown tool");
    expect(offered.callTool).not.toHaveBeenCalled();
  });

  it("refuses a forced call using a filtered-out tool's name when a look-alike is offered", async () => {
    const { c, callTool } = client(["do thing"]);
    const out = await dispatch(c, mcpModelToolName("my.server", "do/thing"));
    expect(out).toContain("Unknown tool");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("offers the sanitized name but executes with the original names", async () => {
    const { c, callTool } = client(["do/thing"]);
    const tools = await collectTools(new Map([["my.server", c]]), new Set());
    expect(tools.find((t) => t.origin === "mcp")).toMatchObject({
      name: mcpModelToolName("my.server", "do/thing"),
      mcpServerName: "my.server",
      mcpToolName: "do/thing",
    });
    await dispatch(c, mcpModelToolName("my.server", "do/thing"));
    expect(callTool).toHaveBeenCalledWith("do/thing", {});
  });
});

describe("forced calls", () => {
  it("refuses a forced call to a tool absent from the catalog", async () => {
    const { c, callTool } = client(["kept"]);
    const out = await dispatch(c, "mcp_my_server_omitted");
    expect(out).toContain("Unknown tool mcp_my_server_omitted");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not case-repair a differently cased mcp_ prefix onto an offered tool", async () => {
    const { c, callTool } = client(["foo"]);
    const out = await dispatch(c, "MCP_my_server_Foo");
    expect(out).toContain("Unknown tool");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not case-repair an omitted name onto a different offered tool", async () => {
    const { c, callTool } = client(["foo"]);
    const out = await dispatch(c, "mcp_my_server_Foo");
    expect(out).toContain("Unknown tool");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("keeps the ordinary unknown-tool error for non-MCP names", async () => {
    const { c, callTool } = client(["foo"]);
    const out = await dispatch(c, "nope");
    expect(out).toContain("Unknown tool nope");
    expect(out).not.toContain("MCP server");
    expect(callTool).not.toHaveBeenCalled();
  });
});
