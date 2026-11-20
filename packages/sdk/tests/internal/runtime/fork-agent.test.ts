/**
 * Tests for fork agent primitive (T1.2, ADRs D110-D114).
 *
 * Uses fixture-mode agents to avoid real LLM cost. Validates inheritance
 * semantics, whitelist isolation, dispose lifecycle, memory-plugin
 * preservation (EC-B), and metadata provenance.
 */

import { describe, expect, it } from "vitest";
import type { Plugin } from "../../../src/internal/plugins/types.js";
import { forkAgentImpl } from "../../../src/internal/runtime/lifecycle/fork-agent.js";
import type { AgentOptions, SDKAgent } from "../../../src/types/agent.js";

interface FakeRun {
  wait: () => Promise<{ result: string; usage?: unknown }>;
  stream?: () => AsyncIterable<unknown>;
}

interface FakeAgent extends SDKAgent {
  readonly options: AgentOptions;
  disposeCalled: boolean;
}

function buildFakeAgent(options: AgentOptions): FakeAgent {
  const agent = {
    agentId: options.agentId ?? `fake-${Math.random().toString(16).slice(2)}`,
    model: options.model,
    options,
    disposeCalled: false,
    events: [] as unknown[],
    async send(_message: unknown): Promise<FakeRun> {
      return {
        stream: async function* () {
          for (const e of (agent as unknown as { events: unknown[] }).events) yield e;
        },
        wait: async () => ({ result: "ok", usage: { inputTokens: 0, outputTokens: 0 } }),
      };
    },
    close() {},
    async reload() {},
    async dispose() {
      agent.disposeCalled = true;
    },
    async [Symbol.asyncDispose]() {
      agent.disposeCalled = true;
    },
    async listArtifacts() {
      return [];
    },
    async downloadArtifact(): Promise<Buffer> {
      throw new Error("unsupported in fake");
    },
  } as unknown as FakeAgent;
  return agent;
}

function makeParent(extra?: Partial<AgentOptions>): FakeAgent {
  const opts: AgentOptions = {
    apiKey: "theo_test_parent",
    model: { id: "openai/gpt-4o-mini" },
    local: {},
    systemPrompt: "You are the parent.",
    ...extra,
  } as AgentOptions;
  return buildFakeAgent(opts);
}

describe("forkAgentImpl (T1.2)", () => {
  it("fork inherits system prompt byte-identical (ADR D112)", async () => {
    const parent = makeParent({ systemPrompt: "You are the parent." });
    let captured: AgentOptions | undefined;
    await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review" },
      {
        create: async (opts) => {
          captured = opts;
          return buildFakeAgent(opts);
        },
      },
    );
    expect(captured?.systemPrompt).toBe("You are the parent.");
  });

  it("fork uses independent agentId", async () => {
    const parent = makeParent();
    let forkOpts: AgentOptions | undefined;
    await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review" },
      {
        create: async (opts) => {
          forkOpts = opts;
          return buildFakeAgent(opts);
        },
      },
    );
    expect(forkOpts?.agentId).toBeUndefined();
  });

  it("fork sets metadata.forkOrigin = options.forkOrigin", async () => {
    const parent = makeParent();
    let forkOpts: AgentOptions | undefined;
    await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review", forkOrigin: "curator" },
      {
        create: async (opts) => {
          forkOpts = opts;
          return buildFakeAgent(opts);
        },
      },
    );
    expect((forkOpts?.metadata as Record<string, unknown> | undefined)?.forkOrigin).toBe("curator");
  });

  it("fork sets metadata.parentAgentId = parent.agentId", async () => {
    const parent = makeParent();
    let forkOpts: AgentOptions | undefined;
    await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review" },
      {
        create: async (opts) => {
          forkOpts = opts;
          return buildFakeAgent(opts);
        },
      },
    );
    expect((forkOpts?.metadata as Record<string, unknown> | undefined)?.parentAgentId).toBe(
      parent.agentId,
    );
  });

  it("fork disposes the auxiliary agent even on success", async () => {
    const parent = makeParent();
    let fakeFork: FakeAgent | undefined;
    await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review" },
      {
        create: async (opts) => {
          fakeFork = buildFakeAgent(opts);
          return fakeFork;
        },
      },
    );
    expect(fakeFork?.disposeCalled).toBe(true);
  });

  it("fork disposes the auxiliary agent even on error", async () => {
    const parent = makeParent();
    let fakeFork: FakeAgent | undefined;
    let errorThrown = false;
    try {
      await forkAgentImpl(
        parent,
        { allowedTools: new Set(), prompt: "review" },
        {
          create: async (opts) => {
            fakeFork = buildFakeAgent(opts);
            fakeFork.send = async () => {
              throw new Error("boom");
            };
            return fakeFork;
          },
        },
      );
    } catch {
      errorThrown = true;
    }
    expect(errorThrown).toBe(true);
    expect(fakeFork?.disposeCalled).toBe(true);
  });

  // EC-B (edge-case review): memory plugins (kind: "memory") survive fork
  it("preserves memory plugins (kind:memory) and drops general/model-provider", async () => {
    const memoryPlugin = {
      name: "test-mem",
      version: "1.0.0",
      kind: "memory" as const,
      createProvider: () => ({}),
    } as unknown as Plugin;
    const generalPlugin = {
      name: "test-general",
      version: "1.0.0",
      kind: "general" as const,
      register: () => {},
    } as unknown as Plugin;
    const parent = makeParent({
      plugins: [memoryPlugin, generalPlugin] as unknown as AgentOptions["plugins"],
    });
    let forkOpts: AgentOptions | undefined;
    await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review" },
      {
        create: async (opts) => {
          forkOpts = opts;
          return buildFakeAgent(opts);
        },
      },
    );
    const forkPlugins = forkOpts?.plugins as unknown as Plugin[] | undefined;
    expect(Array.isArray(forkPlugins)).toBe(true);
    expect(forkPlugins?.length).toBe(1);
    expect(forkPlugins?.[0]?.kind).toBe("memory");
  });

  it("undefined plugins on parent yields undefined plugins on fork", async () => {
    const parent = makeParent({ plugins: undefined });
    let forkOpts: AgentOptions | undefined;
    await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review" },
      {
        create: async (opts) => {
          forkOpts = opts;
          return buildFakeAgent(opts);
        },
      },
    );
    expect(forkOpts?.plugins).toBeUndefined();
  });

  it("returns fork result with usage", async () => {
    const parent = makeParent();
    const result = await forkAgentImpl(
      parent,
      { allowedTools: new Set(), prompt: "review" },
      {
        create: async (opts) => buildFakeAgent(opts),
      },
    );
    expect(result.usage).toBeDefined();
  });
});

describe("forkAgentImpl toolCalls (#750)", () => {
  const run = async (events: unknown[]) =>
    forkAgentImpl(
      makeParent(),
      { allowedTools: new Set(["read"]), prompt: "go" },
      {
        create: async (opts) => {
          const a = buildFakeAgent(opts);
          (a as unknown as { events: unknown[] }).events = events;
          return a;
        },
      },
    );

  it("is empty when the fork called no tools", async () => {
    expect((await run([{ type: "assistant" }])).toolCalls).toEqual([]);
  });

  it("collects calls in order and folds running/completed by call_id", async () => {
    const r = await run([
      { type: "tool_call", call_id: "1", name: "read", status: "running", args: { path: "a" } },
      { type: "tool_call", call_id: "1", name: "read", status: "completed", args: { path: "a" } },
      { type: "tool_call", call_id: "2", name: "grep", status: "error" },
    ]);
    expect(r.toolCalls).toEqual([
      { name: "read", input: { path: "a" } },
      { name: "grep", input: {} },
    ]);
  });

  it("uses {} for non-object args and keeps id-less events separate", async () => {
    const r = await run([
      { type: "tool_call", name: "a", status: "completed", args: "x" },
      { type: "tool_call", name: "a", status: "completed", args: [1] },
    ]);
    expect(r.toolCalls).toEqual([
      { name: "a", input: {} },
      { name: "a", input: {} },
    ]);
  });
});
