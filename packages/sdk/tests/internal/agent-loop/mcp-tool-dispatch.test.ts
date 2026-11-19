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

async function dispatchOn(servers: Record<string, string[]>, forced: string) {
  const clients = Object.entries(servers).map(([n, names]) => [n, client(names)] as const);
  const mcp = new Map(clients.map(([n, x]) => [n, x.c]));
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
    [{ type: "tool_use", id: "c1", name: forced, input: {} }],
    [],
  );
  return { out: JSON.stringify(part), calls: clients.map(([, x]) => x.callTool) };
}

describe("name sanitization", () => {
  it("bounds overlong plain identities to 64 chars and keeps them distinct", () => {
    const a = mcpModelToolName("srv", `t${"_".repeat(80)}a`);
    const b = mcpModelToolName("srv", `t${"_".repeat(80)}b`);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(a.startsWith("mcp__")).toBe(true);
  });

  it("keeps plain names readable", () => {
    expect(mcpModelToolName("srv", "plain-name")).toBe("mcp_srv_plain-name");
    expect(mcpModelToolName("a", "b_c")).toBe("mcp_a_b_c");
  });

  it("maps distinct identities to distinct names", () => {
    const ids: Array<[string, string]> = [
      ["srv", "do/thing"],
      ["srv", "do thing"],
      ["srv", "do_thing"],
      ["srv", "do_thing_5abb2e"],
      ["a_b", "c"],
      ["a", "b_c"],
      ["a", "b_648fa9_c"],
      ["my.server", "x"],
      ["my_server", "x"],
      ["my server", "x"],
    ];
    const names = ids.map(([s, t]) => mcpModelToolName(s, t));
    expect(new Set(names).size).toBe(ids.length);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("keeps distinct names when identities share a long readable prefix", () => {
    const long = "x".repeat(60);
    const a = mcpModelToolName("srv", `${long}/1`);
    const b = mcpModelToolName("srv", `${long}/2`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).toMatch(/_[0-9a-f]{32}$/);
  });

  it("refuses a forced call to a filtered tool whose sanitized form matches an offered tool", async () => {
    const { out, calls } = await dispatchOn(
      { srv: ["do_thing_5abb2e"] },
      mcpModelToolName("srv", "do/thing"),
    );
    expect(out).toContain("Unknown tool");
    expect(calls[0]).not.toHaveBeenCalled();
  });

  it("refuses a forced call across a shifted server/tool boundary", async () => {
    const offered = await dispatchOn({ a: ["b_648fa9_c"] }, mcpModelToolName("a_b", "c"));
    expect(offered.out).toContain("Unknown tool");
    expect(offered.calls[0]).not.toHaveBeenCalled();
    const offered2 = await dispatchOn({ a: ["b_c"] }, mcpModelToolName("a_b", "c"));
    expect(offered2.out).toContain("Unknown tool");
    expect(offered2.calls[0]).not.toHaveBeenCalled();
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
    const omitted = mcpModelToolName("my.server", "omitted");
    const out = await dispatch(c, omitted);
    expect(out).toContain(`Unknown tool ${omitted}`);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not case-repair a differently cased mcp_ prefix onto an offered tool", async () => {
    const { c, callTool } = client(["foo"]);
    const out = await dispatch(c, mcpModelToolName("my.server", "foo").replace(/^mcp/, "MCP"));
    expect(out).toContain("Unknown tool");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not case-repair an omitted name onto a different offered tool", async () => {
    const { c, callTool } = client(["foo"]);
    const out = await dispatch(c, mcpModelToolName("my.server", "foo").toUpperCase());
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
