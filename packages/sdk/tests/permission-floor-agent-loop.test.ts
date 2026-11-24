import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runAgentLoop } from "../src/internal/agent-loop/loop.js";
import type { AgentLoopInputs } from "../src/internal/agent-loop/types.js";
import type { LlmClient, LlmEvent, LlmFinish } from "../src/internal/llm/types.js";
import { PluginManager } from "../src/internal/plugins/manager.js";
import { HooksExecutor } from "../src/internal/runtime/hooks/hooks-executor.js";
import { PermissionEngine } from "../src/permission-engine.js";
import { PermissionPlugin } from "../src/permission-plugin.js";
import type { RunEvent } from "../src/types/run-events.js";
import { removeTempDirRobust } from "./helpers/temp-workspace.js";

/** The loop's own floor: no plugin needed. One tool call on turn 1, then done. */
function llm(name: string, input: Record<string, unknown>): LlmClient {
  let turn = 0;
  return {
    name: "mock",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      yield { type: "text_delta", text: "" };
      turn += 1;
      const calls = turn === 1 ? [{ type: "tool_use" as const, id: "c1", name, input }] : [];
      return {
        stopReason: turn === 1 ? "tool_use" : "end_turn",
        text: "",
        toolCalls: calls,
        inputTokens: 1,
        outputTokens: 1,
      } as unknown as LlmFinish;
    },
  };
}

async function drive(
  cwd: string,
  tool: string,
  input: Record<string, unknown>,
  opts: { plugin?: boolean; hookCalls?: string[] } = {},
) {
  const ran: string[] = [];
  const events: RunEvent[] = [];
  const pluginManager = new PluginManager();
  const plugins = [];
  if (opts.plugin === true) {
    plugins.push(PermissionPlugin.create(new PermissionEngine([{ tool: "*", action: "allow" }])));
  }
  plugins.push({
    name: "spy",
    version: "1.0.0",
    kind: "general" as const,
    register(ctx: { on: (e: string, f: () => void) => void }) {
      ctx.on("pre_tool_call", () => void opts.hookCalls?.push("plugin"));
    },
  });
  await pluginManager.initialize(plugins as never);
  const inputs: AgentLoopInputs = {
    agentId: "a",
    runId: "r",
    userMessage: "go",
    model: { id: "mock-model" },
    llm: llm(tool, input),
    mcp: new Map(),
    hooks: new HooksExecutor(cwd),
    shellCwd: cwd,
    shellSandbox: false,
    maxIterations: 4,
    customTools: [
      {
        name: tool,
        description: tool,
        inputSchema: { type: "object" },
        handler: () => {
          ran.push(tool);
          return "handled";
        },
      },
    ],
    pluginManager,
    runEventSink: (e) => void events.push(e),
    ...(opts.plugin === true ? { permissionMode: "bypassPermissions" as const } : {}),
  };
  await runAgentLoop(inputs);
  const denied = events.filter((e) => e.type === "permission_denied");
  return { ran, denied };
}

describe("the permission floor in the agent loop", () => {
  it("refuses a protected-path write with no permission plugin", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "floor-")));
    onTestFinished(() => removeTempDirRobust(cwd));
    const hookCalls: string[] = [];
    const { ran, denied } = await drive(
      cwd,
      "write_file",
      { path: join(cwd, ".git", "hooks", "pre-commit") },
      { hookCalls },
    );
    expect(ran).toEqual([]);
    expect(hookCalls).toEqual([]); // before plugins
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "floor", toolName: "write_file" });
  });

  it("still refuses in bypassPermissions with PermissionPlugin, once", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "floor-")));
    onTestFinished(() => removeTempDirRobust(cwd));
    const { ran, denied } = await drive(
      cwd,
      "write_file",
      { path: join(cwd, ".git", "hooks", "pre-commit") },
      { plugin: true },
    );
    expect(ran).toEqual([]);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "floor" });
  });

  it("protects the agent workspace cwd, not process.cwd()", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "floor-")));
    onTestFinished(() => removeTempDirRobust(cwd));
    expect(cwd).not.toBe(process.cwd());
    const { ran, denied } = await drive(cwd, "run_command", { command: `rm -rf ${cwd}` });
    expect(ran).toEqual([]);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "floor" });
  });

  it("does not gate reads", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "floor-")));
    onTestFinished(() => removeTempDirRobust(cwd));
    const { ran, denied } = await drive(cwd, "read_file", { path: ".claude/settings.json" });
    expect(denied).toEqual([]);
    expect(ran).toEqual(["read_file"]);
  });
});
