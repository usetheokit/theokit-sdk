/**
 * #1035 — the per-server tool filter seen from the agent loop: what the model is offered, and what
 * a forced dispatch of a filtered-out tool gets back.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../../src/internal/agent-loop/loop.js";
import { dispatchTools, type ResolvedTool } from "../../src/internal/agent-loop/tool-dispatch.js";
import type { AgentLoopInputs } from "../../src/internal/agent-loop/types.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "../../src/internal/llm/types.js";
import { createMcpClient, type McpClient } from "../../src/internal/mcp/client.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";
import type { SDKMessage, SDKToolUseMessage } from "../../src/types/messages.js";

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
    let result = {};
    if (m.method === "tools/list") {
      result = { tools: ["a", "b", "danger"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })) };
    } else if (m.method === "tools/call") {
      fs.appendFileSync(log, m.params.name + "\\n");
      result = { content: [{ type: "text", text: "ran " + m.params.name }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

let dir: string;
let logFile: string;
let client: McpClient;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-filter-loop-"));
  logFile = join(dir, "calls.log");
  writeFileSync(join(dir, "server.cjs"), SERVER);
  client = createMcpClient("fixture", {
    command: process.execPath,
    args: [join(dir, "server.cjs"), logFile],
    tools: { exclude: ["danger"] },
  });
  await client.initialize();
});
afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

const serverCalls = () =>
  existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) : [];

describe("mcp tool filter in the agent loop", () => {
  it("offers the model a and b only, and a model call of danger never reaches the server", async () => {
    const offered: string[][] = [];
    let round = 0;
    const llm: LlmClient = {
      name: "stub",
      async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
        offered.push((request.tools ?? []).map((t) => t.name));
        if (round++ === 0) {
          return {
            stopReason: "tool_use",
            text: "",
            toolCalls: [{ type: "tool_use", id: "c1", name: "mcp_fixture_danger", input: {} }],
          };
        }
        yield { type: "text_delta", text: "done" };
        return { stopReason: "end_turn", text: "done", toolCalls: [] };
      },
    };
    const hooks = new HooksExecutor(dir);
    await hooks.initialize(false);
    await runAgentLoop({
      agentId: "a-1",
      runId: "r-1",
      model: { id: "stub-model" },
      userMessage: "go",
      llm,
      mcp: new Map([["fixture", client]]),
      hooks,
      shellCwd: dir,
      shellSandbox: false,
    } as AgentLoopInputs);
    const first = offered[0] ?? [];
    expect(first).toEqual(expect.arrayContaining(["mcp_fixture_a", "mcp_fixture_b"]));
    expect(first).not.toContain("mcp_fixture_danger");
    expect(serverCalls()).toEqual([]);
  });

  it("a forced dispatch of danger returns a tool error naming tool and server, with no server call", async () => {
    const forced: ResolvedTool = {
      name: "mcp_fixture_danger",
      description: "danger",
      inputSchema: { type: "object" },
      origin: "mcp",
      mcpServerName: "fixture",
      mcpToolName: "danger",
    };
    const inputs = {
      agentId: "a-1",
      runId: "r-1",
      hooks: { run: async () => ({}) },
      mcp: new Map([["fixture", client]]),
    } as unknown as AgentLoopInputs;
    const events: SDKMessage[] = [];
    await dispatchTools(
      inputs,
      [forced],
      [{ type: "tool_use", id: "c-1", name: "mcp_fixture_danger", input: {} }],
      events,
    );
    const done = events.find(
      (e): e is SDKToolUseMessage => e.type === "tool_call" && e.status !== "running",
    );
    expect(done?.status).toBe("error");
    const text = JSON.stringify(done?.result);
    expect(text).toContain("danger");
    expect(text).toContain("fixture");
    expect(serverCalls()).toEqual([]);
  });
});
