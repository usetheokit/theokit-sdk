/** #1035 — per-server MCP tool include/exclude filter. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, ConfigurationError } from "../../src/index.js";
import { runAgentLoop } from "../../src/internal/agent-loop/loop.js";
import { safeListTools } from "../../src/internal/agent-loop/loop-context-init.js";
import { dispatchTools } from "../../src/internal/agent-loop/tool-dispatch.js";
import type { AgentLoopInputs, ResolvedTool } from "../../src/internal/agent-loop/types.js";
import { serializeCloudAgentConfig } from "../../src/internal/cloud-agent/cloud-config-serializer.js";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "../../src/internal/llm/types.js";
import { createMcpClient, type McpClient } from "../../src/internal/mcp/client.js";
import { withToolFilter } from "../../src/internal/mcp/tool-filter.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";
import type { McpStdioServerConfig } from "../../src/types/mcp.js";

const SERVER = `
const fs = require("node:fs");
const log = process.argv[2];
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    fs.appendFileSync(log, m.method + ":" + (m.params && m.params.name || "") + "\\n");
    let result = {};
    if (m.method === "tools/list") result = { tools: ["a", "b", "danger"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })) };
    if (m.method === "tools/call") result = { content: [{ type: "text", text: "ran " + m.params.name }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

let dir: string;
let logFile: string;
let clients: McpClient[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-tool-filter-"));
  logFile = join(dir, "requests.log");
  writeFileSync(logFile, "");
  writeFileSync(join(dir, "server.cjs"), SERVER);
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  setDiagnosticsSink(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function config(tools?: McpStdioServerConfig["tools"]): McpStdioServerConfig {
  return {
    command: process.execPath,
    args: [join(dir, "server.cjs"), logFile],
    ...(tools === undefined ? {} : { tools }),
  };
}

async function start(tools?: McpStdioServerConfig["tools"]): Promise<McpClient> {
  const client = createMcpClient("fx", config(tools));
  clients.push(client);
  await client.initialize();
  return client;
}

function toolResults(request: LlmRequest): Array<{ content: unknown; isError?: boolean }> {
  const parts = request.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
  return parts.filter((p) => p.type === "tool_result") as Array<{
    content: unknown;
    isError?: boolean;
  }>;
}

const requests = (): string[] => readFileSync(logFile, "utf8").split("\n").filter(Boolean);

describe("MCP tool filter (#1035)", () => {
  it("exclude offers the model a and b only", async () => {
    const client = await start({ exclude: ["danger"] });
    const offered = await safeListTools(client, "fx");
    expect(offered.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("include offers only a", async () => {
    const client = await start({ include: ["a"] });
    expect((await safeListTools(client, "fx")).map((t) => t.name)).toEqual(["a"]);
  });

  it("applies exclude after include", async () => {
    const client = await start({ include: ["a", "b"], exclude: ["b"] });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["a"]);
  });

  it("refuses a forced dispatch of danger without a request to the server", async () => {
    const client = await start({ exclude: ["danger"] });
    const tool: ResolvedTool = {
      name: "mcp_fx_danger",
      description: "danger",
      inputSchema: { type: "object" },
      origin: "mcp",
      mcpServerName: "fx",
      mcpToolName: "danger",
    };
    const inputs = {
      agentId: "x",
      runId: "r",
      userMessage: "go",
      model: { id: "m" },
      mcp: new Map([["fx", client]]),
      hooks: new HooksExecutor(process.cwd()),
      shellCwd: process.cwd(),
      shellSandbox: false,
      maxIterations: 2,
    } as unknown as AgentLoopInputs;
    const parts = await dispatchTools(
      inputs,
      [tool],
      [{ type: "tool_use", id: "1", name: "mcp_fx_danger", input: {} }],
      [],
    );
    const text = JSON.stringify(parts);
    expect(text).toContain("danger");
    expect(text).toContain('"fx"'.replace(/"/g, '\\"'));
    expect(requests().filter((r) => r.startsWith("tools/call:"))).toEqual([]);
    const direct = await client.callTool("danger", {});
    expect(direct.isError).toBe(true);
    expect(direct.content[0]?.text).toMatch(/danger.*fx|fx.*danger/);
    expect(requests().some((r) => r === "tools/call:danger")).toBe(false);
    await client.callTool("a", {});
    expect(requests()).toContain("tools/call:a");
  });

  it("refuses a raw tools/call for a filtered-out name and passes other methods", async () => {
    const client = await start({ exclude: ["danger"] });
    const refused = (await client.call?.("tools/call", { name: "danger", arguments: {} })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toMatch(/danger.*fx/);
    expect(requests().some((r) => r.startsWith("tools/call:"))).toBe(false);
    await client.call?.("tools/call", { name: "a", arguments: {} });
    expect(requests()).toContain("tools/call:a");
    await client.call?.("tools/list", {});
    expect(requests()).toContain("tools/list:");
  });

  it("the agent loop offers the model a and b only, and a forced danger call errors with no server call", async () => {
    const client = await start({ exclude: ["danger"] });
    const offered: string[][] = [];
    const resultParts: Array<{ content: unknown; isError?: boolean }> = [];
    let round = 0;
    const llm: LlmClient = {
      name: "stub",
      async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
        offered.push((request.tools ?? []).map((t) => t.name));
        round += 1;
        if (round === 1) {
          return {
            stopReason: "tool_use",
            text: "",
            toolCalls: [{ type: "tool_use", id: "c1", name: "mcp_fx_danger", input: {} }],
          };
        }
        resultParts.push(...toolResults(request));
        yield { type: "text_delta", text: "done" };
        return { stopReason: "end_turn", text: "done", toolCalls: [] };
      },
    };
    const hooks = new HooksExecutor(dir);
    await hooks.initialize(false);
    await runAgentLoop({
      agentId: "filter",
      runId: "run-filter",
      model: { id: "openai/gpt-4o-mini" },
      userMessage: "go",
      llm,
      mcp: new Map([["fx", client]]),
      hooks,
      shellCwd: dir,
      shellSandbox: false,
    });
    const mcpOffered = (offered[0] ?? []).filter((n) => n.startsWith("mcp_"));
    expect(mcpOffered.sort()).toEqual(["mcp_fx_a", "mcp_fx_b"]);
    expect(resultParts).toHaveLength(1);
    expect(resultParts[0]?.isError).toBe(true);
    expect(String(resultParts[0]?.content)).toMatch(/danger/);
    expect(String(resultParts[0]?.content)).toMatch(/fx/);
    expect(requests().some((r) => r.startsWith("tools/call:"))).toBe(false);
  });

  it("a forced call to a tool whose model-facing name was sanitized still names the originals", async () => {
    let serverCalls = 0;
    const inner: McpClient = {
      name: "my.server",
      initialize: async () => {},
      close: async () => {},
      listTools: async () =>
        ["a", "danger.tool"].map((name) => ({ name, description: name, inputSchema: {} })),
      callTool: async () => {
        serverCalls += 1;
        return { content: [{ type: "text", text: "ran" }] };
      },
    };
    const client = withToolFilter(inner, "my.server", { exclude: ["danger.tool"] });
    const offered: string[][] = [];
    const results: Array<{ content: unknown; isError?: boolean }> = [];
    let round = 0;
    const llm: LlmClient = {
      name: "stub",
      async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
        offered.push((request.tools ?? []).map((t) => t.name));
        round += 1;
        if (round === 1) {
          return {
            stopReason: "tool_use",
            text: "",
            toolCalls: [
              { type: "tool_use", id: "c1", name: "mcp_my_server_danger_tool", input: {} },
            ],
          };
        }
        results.push(...toolResults(request));
        yield { type: "text_delta", text: "done" };
        return { stopReason: "end_turn", text: "done", toolCalls: [] };
      },
    };
    const hooks = new HooksExecutor(dir);
    await hooks.initialize(false);
    await runAgentLoop({
      agentId: "filter2",
      runId: "run-filter2",
      model: { id: "openai/gpt-4o-mini" },
      userMessage: "go",
      llm,
      mcp: new Map([["my.server", client]]),
      hooks,
      shellCwd: dir,
      shellSandbox: false,
    });
    expect((offered[0] ?? []).filter((n) => n.startsWith("mcp_"))).toEqual(["mcp_my_server_a"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(String(results[0]?.content)).toContain('"danger.tool"');
    expect(String(results[0]?.content)).toContain('"my.server"');
    expect(serverCalls).toBe(0);
  });

  it("warns once about an include name the server does not list", async () => {
    const messages: string[] = [];
    setDiagnosticsSink((m) => messages.push(m));
    const client = await start({ include: ["a", "typo"] });
    await client.listTools();
    await client.listTools();
    expect(messages.filter((m) => m.includes("typo"))).toHaveLength(1);
  });

  it('Agent.create rejects exclude: [""] with invalid_mcp_tool_filter', async () => {
    const err = await Agent.create({
      apiKey: "theo_test_1035",
      model: { id: "composer-2" },
      local: { cwd: dir },
      mcpServers: { fx: { ...config({ exclude: [""] }) } },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).code).toBe("invalid_mcp_tool_filter");
    expect((err as ConfigurationError).message).toContain("fx");
  });

  it("the cloud payload carries only include and exclude", () => {
    const payload = serializeCloudAgentConfig({
      model: { id: "composer-2" },
      cloud: { repos: [{ url: "https://example.test/r.git" }] },
      mcpServers: {
        h: {
          type: "http",
          url: "https://x.test",
          tools: { exclude: ["danger"], token: "secret" } as never,
        },
      },
    } as never);
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(JSON.stringify(payload)).toContain("danger");
  });
});
