/**
 * usetheokit/theokit-sdk#381 — which BUILTIN tools the agent loop declares to the model.
 *
 * The defect was that `collectTools` prepended `shell` with no way for a consumer to opt out: it
 * took no options and consulted no config, and the array reached the provider through
 * `tools: ctx.tools.map(toLlmTool)` with nothing in between. A consumer whose sandbox scope cannot
 * admit `shell` had only one move left — veto the call in a `pre_tool_call` hook — which pays for
 * the tool twice: 267 characters of schema in every request of every round, and a round the model
 * can spend discovering a refusal it had no way to anticipate.
 *
 * The oracle here is the REQUEST, not the loop's internal array. `ctx.tools` is where the fix
 * lives, so asserting on it would let a regression in the mapping to `LlmRequest.tools` pass — and
 * what the defect is about is what the model is shown, which is the request. Every case below
 * drives the production `runAgentLoop` with a stub `LlmClient` that records the tool names the
 * transport was handed.
 *
 * Anti-vacuity: each withholding case is paired with the same run WITHOUT the option, asserting the
 * tool IS declared. A filter that silently dropped everything, or one that did nothing at all,
 * fails one half of every pair.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { runAgentLoop } from "../src/internal/agent-loop/loop.js";
import type { MemoryToolSpec } from "../src/internal/agent-loop/types.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "../src/internal/llm/types.js";
import { HooksExecutor } from "../src/internal/runtime/hooks/hooks-executor.js";
import type { BuiltinToolName } from "../src/types/agent.js";
import { removeTempDirRobust } from "./helpers/temp-workspace.js";

/** Records the tool names of every request, then closes the turn with plain text. */
function recordingClient(seen: string[][]): LlmClient {
  return {
    name: "stub",
    async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
      seen.push((request.tools ?? []).map((tool) => tool.name));
      yield { type: "text_delta", text: "ok" };
      return { stopReason: "end_turn", text: "ok", toolCalls: [] };
    },
  };
}

/**
 * Calls one tool by name on the first round, then closes on the second. Used to show what a model
 * that invents a withheld tool name actually gets back.
 */
function clientCalling(name: string, seen: string[][]): LlmClient {
  let round = 0;
  return {
    name: "stub",
    async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
      seen.push((request.tools ?? []).map((tool) => tool.name));
      round += 1;
      if (round === 1) {
        return {
          stopReason: "tool_use",
          text: "",
          toolCalls: [{ type: "tool_use", id: "call-1", name, input: { command: "echo hi" } }],
        };
      }
      yield { type: "text_delta", text: "done" };
      return { stopReason: "end_turn", text: "done", toolCalls: [] };
    },
  };
}

function memoryToolSpec(name: string): MemoryToolSpec {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "{}",
  };
}

describe("withheldBuiltinTools — what the model is shown", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-withheld-builtins-"));
    const dir = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(dir);
    });
  });

  async function declaredTools(options: {
    withheld?: ReadonlyArray<BuiltinToolName>;
    memoryTools?: ReadonlyArray<MemoryToolSpec>;
    client?: LlmClient;
    seen?: string[][];
  }): Promise<string[]> {
    const seen = options.seen ?? [];
    const hooks = new HooksExecutor(cwd);
    await hooks.initialize(false);
    await runAgentLoop({
      agentId: "withheld-builtins",
      runId: "run-withheld-builtins",
      model: { id: "openai/gpt-4o-mini" },
      userMessage: "hello",
      llm: options.client ?? recordingClient(seen),
      mcp: new Map(),
      hooks,
      shellCwd: cwd,
      shellSandbox: false,
      ...(options.withheld !== undefined ? { withheldBuiltinTools: options.withheld } : {}),
      ...(options.memoryTools !== undefined ? { memoryTools: options.memoryTools } : {}),
    });
    const first = seen[0];
    expect(first, "the stub client was never asked for a turn").toBeDefined();
    return first ?? [];
  }

  it("test_shell_is_declared_when_nothing_is_withheld", async () => {
    const tools = await declaredTools({});

    expect(tools, "the default catalog must be unchanged by #381").toContain("shell");
  });

  it("test_withholding_shell_removes_it_from_the_declared_catalog", async () => {
    const tools = await declaredTools({ withheld: ["shell"] });

    expect(
      tools,
      `shell was withheld and still reached the model: ${tools.join(", ")}`,
    ).not.toContain("shell");
  });

  it("test_withholding_shell_leaves_the_memory_builtins_declared", async () => {
    const memoryTools = [memoryToolSpec("memory_search"), memoryToolSpec("memory_get")];

    const tools = await declaredTools({ withheld: ["shell"], memoryTools });

    expect(tools.slice().sort(), "withholding one builtin must not withdraw the others").toEqual([
      "memory_get",
      "memory_search",
    ]);
  });

  it("test_memory_builtins_are_declared_when_nothing_is_withheld", async () => {
    const memoryTools = [memoryToolSpec("memory_search"), memoryToolSpec("memory_get")];

    const tools = await declaredTools({ memoryTools });

    expect(tools.slice().sort()).toEqual(["memory_get", "memory_search", "shell"]);
  });

  it("test_withholding_a_memory_builtin_removes_only_that_one", async () => {
    const memoryTools = [memoryToolSpec("memory_search"), memoryToolSpec("memory_get")];

    const tools = await declaredTools({ withheld: ["memory_search"], memoryTools });

    expect(tools, "memory_search was withheld").not.toContain("memory_search");
    expect(tools, "memory_get was not withheld and must survive").toContain("memory_get");
    expect(tools, "shell was not withheld and must survive").toContain("shell");
  });

  it("test_withholding_every_builtin_leaves_an_empty_catalog", async () => {
    const memoryTools = [memoryToolSpec("memory_search"), memoryToolSpec("memory_get")];

    const tools = await declaredTools({
      withheld: ["shell", "memory_search", "memory_get"],
      memoryTools,
    });

    expect(tools, `expected no declared tools, got: ${tools.join(", ")}`).toEqual([]);
  });

  it("test_an_empty_withhold_list_declares_the_full_catalog", async () => {
    // The option must be inert when present-but-empty: a consumer computing the list at runtime
    // should not lose their shell tool because the computation produced no entries.
    const tools = await declaredTools({ withheld: [] });

    expect(tools).toContain("shell");
  });

  it("test_a_withheld_shell_call_is_not_executed", async () => {
    // The point of withholding over denying: the tool is not in the catalog, so a model that
    // invents the name resolves to nothing and the loop answers `Unknown tool shell` rather than
    // running a command. Without the fix this call would have executed `echo hi`.
    const seen: string[][] = [];
    const hooks = new HooksExecutor(cwd);
    await hooks.initialize(false);

    const result = await runAgentLoop({
      agentId: "withheld-exec",
      runId: "run-withheld-exec",
      model: { id: "openai/gpt-4o-mini" },
      userMessage: "hello",
      llm: clientCalling("shell", seen),
      mcp: new Map(),
      hooks,
      shellCwd: cwd,
      shellSandbox: false,
      withheldBuiltinTools: ["shell"],
    });

    const rendered = JSON.stringify(result.events);
    expect(rendered, "a withheld builtin must not be dispatched").toContain("Unknown tool shell");
    expect(
      seen[0],
      "shell must be absent from the catalog of the round that called it",
    ).not.toContain("shell");
  });

  it("test_a_declared_shell_call_still_executes", async () => {
    // Anti-vacuity for the case above: the same invented call against the default catalog does NOT
    // produce `Unknown tool`, so that string is evidence of withholding rather than of the harness.
    const seen: string[][] = [];
    const hooks = new HooksExecutor(cwd);
    await hooks.initialize(false);

    const result = await runAgentLoop({
      agentId: "declared-exec",
      runId: "run-declared-exec",
      model: { id: "openai/gpt-4o-mini" },
      userMessage: "hello",
      llm: clientCalling("shell", seen),
      mcp: new Map(),
      hooks,
      shellCwd: cwd,
      shellSandbox: false,
    });

    expect(JSON.stringify(result.events)).not.toContain("Unknown tool shell");
    expect(seen[0]).toContain("shell");
  });
});
