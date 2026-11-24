/**
 * What a child agent inherits from its parent, and what overrides it.
 *
 * Split out of `subagent-delegation.test.ts` (2026-09-02). One reason to change: the rules for
 * apiKey, model, plugins and origin stamping.
 */
import { describe, expect, it, vi } from "vitest";
import {
  agentOptionsFromDefinition,
  SubAgent,
  subAgentToolsFromDefinitions,
} from "../../src/a2a/subagent.js";
import type { AgentFacadePort } from "../../src/internal/runtime/registry/agent-factory-registry.js";
import { setAgentFacade } from "../../src/internal/runtime/registry/agent-factory-registry.js";
import { useTempCwd } from "../helpers/temp-workspace.js";
import { delegateWithParent } from "./_helpers/delegation-fixture.js";

// Agent.create defaults its workspace to process.cwd(), which during a test run is the
// package itself — this file created agents without saying where, and the state landed in
// packages/sdk/.theokit/. See useTempCwd's docblock for the 540 MB that bought.
useTempCwd();

describe("SubAgent inheritance", () => {
  it("inherits the parent's apiKey and model into the child agent", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "ok" }) }),
      dispose: vi.fn(),
    });
    setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);

    const tool = SubAgent.create({ name: "t", description: "d", instructions: "i" });
    // The parent run publishes its resolved credentials for the duration of the loop.
    await delegateWithParent(
      tool,
      { apiKey: "theo_test_parent", model: { id: "openai/gpt-4o-mini" } },
      "task",
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "theo_test_parent", model: { id: "openai/gpt-4o-mini" } }),
    );
  });

  it("prefers the subagent's explicit model over the inherited one", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "ok" }) }),
      dispose: vi.fn(),
    });
    setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);

    const tool = SubAgent.create({
      name: "t",
      description: "d",
      instructions: "i",
      model: "anthropic/claude-3-5-haiku",
    });
    await delegateWithParent(
      tool,
      { apiKey: "theo_test_parent", model: { id: "openai/gpt-4o-mini" } },
      "task",
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "theo_test_parent",
        model: { id: "anthropic/claude-3-5-haiku" },
      }),
    );
  });

  it("stamps origin {kind:'coordinator'} on the delegated child's send (SE3)", async () => {
    const sendSpy = vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "ok" }) });
    const mockCreate = vi.fn().mockResolvedValue({ send: sendSpy, dispose: vi.fn() });
    setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);

    const tool = SubAgent.create({ name: "t", description: "d", instructions: "i" });
    await tool.handler({ input: "task" });

    // The child's turn is initiated by the coordinating parent — provenance stamped.
    expect(sendSpy).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({ origin: { kind: "coordinator" } }),
    );
  });

  it("inherits the parent's plugins (permission gate) into the child agent (#55)", async () => {
    // Security (#55): arg-level permission rules live in a parent plugin. A
    // delegated child must run under the SAME plugins, or its inner tool calls
    // escape the parent's gate. The child Agent.create must receive them.
    const mockCreate = vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "ok" }) }),
      dispose: vi.fn(),
    });
    setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);

    const tool = SubAgent.create({ name: "t", description: "d", instructions: "i" });
    const permissionPlugin = { name: "perm", hooks: {} };
    await delegateWithParent(
      tool,
      {
        apiKey: "theo_test_parent",
        // biome-ignore lint/suspicious/noExplicitAny: minimal plugin stand-in for the wiring assertion.
        plugins: [permissionPlugin as any],
      },
      "task",
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: [permissionPlugin] }),
    );
  });

  describe("subAgentToolsFromDefinitions (declarative `agents` → delegation tools)", () => {
    it("converts each AgentDefinition into a named delegation tool", () => {
      const tools = subAgentToolsFromDefinitions(
        {
          translator: {
            description: "Translate to French",
            prompt: "Translate English to French.",
          },
          summarizer: { description: "Summarize text", prompt: "Summarize." },
        },
        [],
      );
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(["summarizer", "translator"]);
      const translator = tools.find((t) => t.name === "translator");
      expect(translator?.description).toBe("Translate to French");
      expect(typeof translator?.handler).toBe("function");
    });

    it("builds the child with the definition's prompt as instructions", async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "Bonjour" }) }),
        dispose: vi.fn(),
      });
      setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);

      const tool = subAgentToolsFromDefinitions(
        { translator: { description: "d", prompt: "Translate English to French." } },
        [],
      )[0]!;
      await delegateWithParent(tool, { apiKey: "theo_test_parent" }, "good morning");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "theo_test_parent",
          systemPrompt: "Translate English to French.",
        }),
      );
    });

    it("uses the definition's explicit model, and inherits when it is 'inherit'", async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "ok" }) }),
        dispose: vi.fn(),
      });
      setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);

      const explicit = subAgentToolsFromDefinitions(
        { a: { description: "d", prompt: "p", model: { id: "anthropic/claude-3-5-haiku" } } },
        [],
      )[0]!;
      await delegateWithParent(explicit, { apiKey: "k", model: { id: "openai/gpt-4o-mini" } }, "x");
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: { id: "anthropic/claude-3-5-haiku" } }),
      );

      mockCreate.mockClear();
      const inheriting = subAgentToolsFromDefinitions(
        { b: { description: "d", prompt: "p", model: "inherit" } },
        [],
      )[0]!;
      await delegateWithParent(
        inheriting,
        { apiKey: "k", model: { id: "openai/gpt-4o-mini" } },
        "x",
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: { id: "openai/gpt-4o-mini" } }),
      );
    });

    it("scopes the child to the whitelisted parent tools (def.tools)", async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "ok" }) }),
        dispose: vi.fn(),
      });
      setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);

      const parentTools = [
        { name: "read_file", description: "", inputSchema: {}, handler: () => "" },
        { name: "write_file", description: "", inputSchema: {}, handler: () => "" },
      ];
      const reader = subAgentToolsFromDefinitions(
        { reader: { description: "d", prompt: "p", tools: ["read_file"] } },
        parentTools,
      )[0]!;
      await delegateWithParent(reader, { apiKey: "k" }, "x");

      const passedTools = mockCreate.mock.calls[0]![0].tools as Array<{ name: string }>;
      expect(passedTools.map((t) => t.name)).toEqual(["read_file"]);
    });

    it("a whitelist also withholds the builtins it leaves out on the delegation path", async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ wait: () => Promise.resolve({ result: "ok" }) }),
        dispose: vi.fn(),
      });
      setAgentFacade({ create: mockCreate } as unknown as AgentFacadePort);
      const reader = subAgentToolsFromDefinitions(
        { reader: { description: "d", prompt: "p", tools: ["read_file"] } },
        [{ name: "read_file", description: "", inputSchema: {}, handler: () => "" }],
      )[0]!;
      await delegateWithParent(reader, { apiKey: "k" }, "x");
      expect(mockCreate.mock.calls[0]![0].withheldBuiltinTools).toContain("shell");
    });
  });

  describe("agentOptionsFromDefinition", () => {
    const def = { description: "d", prompt: "p" };

    it("inherit takes the parent's ModelSelection with its reasoning params", () => {
      const model = { id: "m", params: [{ id: "thinking", value: "low" }] };
      expect(agentOptionsFromDefinition({ ...def, model: "inherit" }, { model }).model).toEqual(
        model,
      );
    });

    it("a sandboxed parent stays sandboxed even when the definition says sandbox: false", () => {
      const o = agentOptionsFromDefinition(
        { ...def, sandbox: false },
        { local: { sandboxOptions: { enabled: true } } },
      );
      expect(o.local?.sandboxOptions?.enabled).toBe(true);
    });

    it("forwards credential, cwd and setting sources from the parent", () => {
      const o = agentOptionsFromDefinition(def, {
        apiKey: "k",
        local: { cwd: "/w", settingSources: ["project"] },
      });
      expect(o.apiKey).toBe("k");
      expect(o.local?.cwd).toBe("/w");
      expect(o.local?.settingSources).toEqual(["project"]);
    });

    it("an empty withheldBuiltinTools on the definition keeps the parent's shell withheld", () => {
      const o = agentOptionsFromDefinition(
        { ...def, withheldBuiltinTools: [] },
        { withheldBuiltinTools: ["shell"] },
      );
      expect(o.withheldBuiltinTools).toEqual(["shell"]);
    });
  });
});
