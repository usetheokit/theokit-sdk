/**
 * B-002 — `buildAgentMemory`, the `agent.memory` direct API.
 *
 * `agent-memory-direct-api.test.ts` already drives write/recall through a whole
 * `Agent`, which is why the module reads 37/49 lines. It never reaches
 * `delete()`, `adapter()` or the missing-userId guard — all three `FNDA:0` /
 * uncovered before this file — and it never asserts the fan-out failure
 * semantics that decide whether a partial outage loses data or degrades.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "../../../src/errors.js";
import { buildAgentMemory } from "../../../src/internal/local-agent/local-agent-memory-direct.js";
import {
  isLanceAvailable,
  LanceIndex,
  lanceStoragePath,
} from "../../../src/internal/memory/lance-index.js";
import { resolveMemoryRoot } from "../../../src/internal/memory/storage/memory-root.js";
import { PluginManager } from "../../../src/internal/plugins/manager.js";
import { Plugin } from "../../../src/internal/plugins/types.js";
import { mkMemoryId } from "../../../src/memory-adapter-helpers.js";
import type {
  MemoryAdapter,
  MemoryAdapterCapabilities,
  MemoryContext,
  MemoryFact,
  MemoryId,
} from "../../../src/types/memory-adapter.js";

const noCaps: MemoryAdapterCapabilities = {
  history: false,
  sessions: false,
  tenancy: false,
  reasoning: false,
  toolSchemas: false,
  prefetch: false,
};

interface AdapterScript {
  id: string;
  onInitialize?: () => void;
  onWrite?: (content: unknown, ctx: MemoryContext) => void;
  writeThrows?: Error;
  recallReturns?: MemoryFact[];
  recallThrows?: Error;
  onRecall?: (query: string, ctx: MemoryContext, k: number | undefined) => void;
  onDelete?: (id: MemoryId) => void;
  omitInitialize?: boolean;
}

function makeAdapter(script: AdapterScript): MemoryAdapter {
  const adapter: MemoryAdapter = {
    id: script.id,
    capabilities: noCaps,
    isAvailable: () => true,
    write: (content, ctx) => {
      script.onWrite?.(content, ctx);
      if (script.writeThrows !== undefined) return Promise.reject(script.writeThrows);
      return Promise.resolve(mkMemoryId(script.id, "written"));
    },
    recall: (query, ctx, k) => {
      script.onRecall?.(query, ctx, k);
      if (script.recallThrows !== undefined) return Promise.reject(script.recallThrows);
      return Promise.resolve(script.recallReturns ?? []);
    },
    delete: (id) => {
      script.onDelete?.(id);
      return Promise.resolve();
    },
  };
  if (script.omitInitialize === true) return adapter;
  return {
    ...adapter,
    initialize: () => {
      script.onInitialize?.();
      return Promise.resolve();
    },
  };
}

/** A real `PluginManager` carrying the given adapters as `kind: "memory"` plugins. */
async function managerWith(adapters: ReadonlyArray<MemoryAdapter>): Promise<PluginManager> {
  const manager = new PluginManager();
  await manager.initialize(
    adapters.map((adapter, i) =>
      Plugin.create({
        name: `mem-${adapter.id}-${i}`,
        version: "1.0.0",
        kind: "memory",
        createProvider: () => adapter,
      }),
    ),
  );
  return manager;
}

const demoCtx: MemoryContext = { userId: "demo" };

describe("buildAgentMemory — context merge", () => {
  it("lets the caller's userId win over the agent default", async () => {
    const seen: MemoryContext[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: (_c, ctx) => seen.push(ctx) }),
    ]);

    await buildAgentMemory(manager, "/nonexistent-b002", { userId: "agent-default" }).write("hi", {
      userId: "caller",
    });

    expect(seen[0]?.userId).toBe("caller");
  });

  it("falls back to the agent default when the caller passes no userId", async () => {
    const seen: MemoryContext[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: (_c, ctx) => seen.push(ctx) }),
    ]);

    await buildAgentMemory(manager, "/nonexistent-b002", { userId: "agent-default" }).write("hi");

    expect(seen[0]?.userId).toBe("agent-default");
  });

  it("carries the optional fields through, caller-first", async () => {
    const seen: MemoryContext[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: (_c, ctx) => seen.push(ctx) }),
    ]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", {
      userId: "u",
      agentId: "default-agent",
      sessionId: "default-session",
      tenantId: "default-tenant",
      tags: ["default"],
      metadata: { from: "default" },
    });

    await memory.write("hi", { agentId: "caller-agent", tags: ["caller"] });

    expect(seen[0]).toEqual({
      userId: "u",
      agentId: "caller-agent",
      sessionId: "default-session",
      tenantId: "default-tenant",
      tags: ["caller"],
      metadata: { from: "default" },
    });
  });

  it("lets a per-call context override every field of the agent default", async () => {
    // The opposite end of the ladder from the row below: each of the six fields
    // must resolve independently, so a caller that fills them all keeps them all.
    const seen: MemoryContext[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: (_c, ctx) => seen.push(ctx) }),
    ]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", {
      userId: "default-user",
      agentId: "default-agent",
      sessionId: "default-session",
      tenantId: "default-tenant",
      tags: ["default"],
      metadata: { from: "default" },
    });
    const perCall: MemoryContext = {
      userId: "caller-user",
      agentId: "caller-agent",
      sessionId: "caller-session",
      tenantId: "caller-tenant",
      tags: ["caller"],
      metadata: { from: "caller" },
    };

    await memory.write("hi", perCall);

    expect(seen[0]).toEqual(perCall);
  });

  it("applies every agent-level default when the caller passes no context at all", async () => {
    // The common call shape: `agent.memory.write(text)` with the context configured
    // once on the agent. Each optional field has to fall through to its default.
    const seen: MemoryContext[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: (_c, ctx) => seen.push(ctx) }),
    ]);
    const defaults: MemoryContext = {
      userId: "u",
      agentId: "billing-agent",
      sessionId: "s-1",
      tenantId: "acme",
      tags: ["prod"],
      metadata: { source: "agent" },
    };

    await buildAgentMemory(manager, "/nonexistent-b002", defaults).write("hi");

    expect(seen[0]).toEqual(defaults);
  });

  it("omits every optional field neither the caller nor the default supplies", async () => {
    // The other half of the caller-wins ladder: an absent field must stay absent
    // rather than arrive as an explicit `undefined` an adapter would have to filter.
    const seen: MemoryContext[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: (_c, ctx) => seen.push(ctx) }),
    ]);

    await buildAgentMemory(manager, "/nonexistent-b002", { userId: "u" }).write("hi");

    expect(seen[0]).toEqual({ userId: "u" });
    expect(Object.keys(seen[0] ?? {})).toEqual(["userId"]);
  });

  it("omits the optional fields when the CALLER passes a context that lacks them", async () => {
    // The mirror of the row above: here the caller's context object exists but
    // carries only a userId, and the agent has no defaults at all.
    const seen: MemoryContext[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: (_c, ctx) => seen.push(ctx) }),
    ]);

    await buildAgentMemory(manager, "/nonexistent-b002", undefined).write("hi", { userId: "u" });

    expect(Object.keys(seen[0] ?? {})).toEqual(["userId"]);
  });

  it("rejects with ConfigurationError(memory_context_missing_user_id) when no userId is resolvable", async () => {
    const manager = await managerWith([makeAdapter({ id: "a" })]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", undefined);

    await expect(memory.write("hi")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(memory.write("hi")).rejects.toMatchObject({
      code: "memory_context_missing_user_id",
    });
  });

  it("does NOT reject when a userId is present — the guard is not a blanket refusal", async () => {
    // rules/testing.md § 4.2: without this row, `if (true)` on the guard passes.
    const manager = await managerWith([makeAdapter({ id: "a" })]);

    await expect(
      buildAgentMemory(manager, "/nonexistent-b002", undefined).write("hi", { userId: "u" }),
    ).resolves.toBe("a:written");
  });
});

describe("buildAgentMemory — adapter resolution", () => {
  it("rejects with ConfigurationError(no_memory_adapter) when no memory plugin is registered", async () => {
    const manager = await managerWith([]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", demoCtx);

    await expect(memory.recall("q")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(memory.recall("q")).rejects.toMatchObject({ code: "no_memory_adapter" });
  });

  it("initializes each adapter exactly once across repeated calls (EC-I)", async () => {
    let inits = 0;
    const manager = await managerWith([makeAdapter({ id: "a", onInitialize: () => inits++ })]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", demoCtx);

    await memory.write("one");
    await memory.write("two");
    await memory.recall("q");

    expect(inits).toBe(1);
  });

  it("accepts an adapter that declares no initialize()", async () => {
    const manager = await managerWith([makeAdapter({ id: "a", omitInitialize: true })]);

    await expect(buildAgentMemory(manager, "/nonexistent-b002", demoCtx).write("hi")).resolves.toBe(
      "a:written",
    );
  });
});

describe("buildAgentMemory — write fan-out", () => {
  it("writes to every registered adapter", async () => {
    const written: string[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onWrite: () => written.push("a") }),
      makeAdapter({ id: "b", onWrite: () => written.push("b") }),
    ]);

    await buildAgentMemory(manager, "/nonexistent-b002", demoCtx).write("hi");

    expect(written.sort()).toEqual(["a", "b"]);
  });

  it("returns the first fulfilled id when one adapter is down", async () => {
    const manager = await managerWith([
      makeAdapter({ id: "a", writeThrows: new Error("adapter a is down") }),
      makeAdapter({ id: "b" }),
    ]);

    await expect(buildAgentMemory(manager, "/nonexistent-b002", demoCtx).write("hi")).resolves.toBe(
      "b:written",
    );
  });

  it("surfaces the first adapter's error when EVERY adapter fails", async () => {
    const first = new Error("adapter a is down");
    const manager = await managerWith([
      makeAdapter({ id: "a", writeThrows: first }),
      makeAdapter({ id: "b", writeThrows: new Error("adapter b is down") }),
    ]);

    await expect(buildAgentMemory(manager, "/nonexistent-b002", demoCtx).write("hi")).rejects.toBe(
      first,
    );
  });
});

describe("buildAgentMemory — recall merge", () => {
  it("dedupes facts by content across adapters", async () => {
    const manager = await managerWith([
      makeAdapter({
        id: "a",
        recallReturns: [
          { id: mkMemoryId("a", "1"), content: "alpha" },
          { id: mkMemoryId("a", "2"), content: "beta" },
        ],
      }),
      makeAdapter({
        id: "b",
        recallReturns: [
          { id: mkMemoryId("b", "1"), content: "alpha" },
          { id: mkMemoryId("b", "2"), content: "gamma" },
        ],
      }),
    ]);

    const facts = await buildAgentMemory(manager, "/nonexistent-b002", demoCtx).recall("q");

    expect(facts.map((f) => f.content)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("forwards the query and the requested result count to each adapter", async () => {
    // `k` is the caller's cap on how much memory reaches the prompt. Dropped, an
    // adapter returns its own default and the recall silently over-fetches into
    // the context window.
    const calls: Array<{ query: string; k: number | undefined }> = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onRecall: (query, _ctx, k) => calls.push({ query, k }) }),
      makeAdapter({ id: "b", onRecall: (query, _ctx, k) => calls.push({ query, k }) }),
    ]);

    await buildAgentMemory(manager, "/nonexistent-b002", demoCtx).recall("deploy target", {}, 3);

    expect(calls).toEqual([
      { query: "deploy target", k: 3 },
      { query: "deploy target", k: 3 },
    ]);
  });

  it("degrades gracefully — a failing adapter does not lose the healthy one's facts", async () => {
    const manager = await managerWith([
      makeAdapter({ id: "a", recallThrows: new Error("adapter a is down") }),
      makeAdapter({ id: "b", recallReturns: [{ id: mkMemoryId("b", "1"), content: "beta" }] }),
    ]);

    const facts = await buildAgentMemory(manager, "/nonexistent-b002", demoCtx).recall("q");

    expect(facts.map((f) => f.content)).toEqual(["beta"]);
  });
});

describe("buildAgentMemory — delete routing", () => {
  it("routes the delete to the adapter whose id matches the MemoryId prefix", async () => {
    const deletedByA: MemoryId[] = [];
    const deletedByB: MemoryId[] = [];
    const manager = await managerWith([
      makeAdapter({ id: "a", onDelete: (id) => deletedByA.push(id) }),
      makeAdapter({ id: "b", onDelete: (id) => deletedByB.push(id) }),
    ]);

    await buildAgentMemory(manager, "/nonexistent-b002", demoCtx).delete(mkMemoryId("b", "42"));

    expect(deletedByA).toEqual([]);
    expect(deletedByB).toEqual(["b:42"]);
  });

  it("rejects with ConfigurationError naming the registered adapters for an unknown prefix", async () => {
    const manager = await managerWith([makeAdapter({ id: "a" }), makeAdapter({ id: "b" })]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", demoCtx);

    await expect(memory.delete(mkMemoryId("zzz", "1"))).rejects.toBeInstanceOf(ConfigurationError);
    await expect(memory.delete(mkMemoryId("zzz", "1"))).rejects.toThrow(
      'No adapter found for MemoryId prefix "zzz" (registered: a, b).',
    );
  });
});

describe("buildAgentMemory — adapter() introspection", () => {
  it("returns null before anything triggered initialization", async () => {
    const manager = await managerWith([makeAdapter({ id: "a" })]);

    expect(buildAgentMemory(manager, "/nonexistent-b002", demoCtx).adapter()).toBeNull();
  });

  it("returns the FIRST adapter once initialization has resolved", async () => {
    const manager = await managerWith([makeAdapter({ id: "a" }), makeAdapter({ id: "b" })]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", demoCtx);

    await memory.write("hi");

    expect(memory.adapter()?.id).toBe("a");
  });

  it("returns null after initialization when no adapter was registered", async () => {
    const manager = await managerWith([]);
    const memory = buildAgentMemory(manager, "/nonexistent-b002", demoCtx);

    await expect(memory.write("hi")).rejects.toBeInstanceOf(ConfigurationError);

    expect(memory.adapter()).toBeNull();
  });
});

describe.skipIf(!isLanceAvailable())("buildAgentMemory — delete forgets the Lance index", () => {
  const dirs: string[] = [];
  const opened: LanceIndex[] = [];
  const embedding = {
    dimension: 2,
    embed: async (t: string[]) => {
      await new Promise((r) => setTimeout(r, 20));
      return t.map(() => [0.5, 0.5]);
    },
  } as never;
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    text: id,
    source: "memory" as const,
    namespace: "default",
    scope: "agent",
    user_id: "u",
    timestamp: 0,
    fact_id: "a:42",
    ...extra,
  });
  async function agentIndex() {
    const cwd = mkdtempSync(join(tmpdir(), "mem-forget-"));
    dirs.push(cwd);
    const index = await LanceIndex.open({
      cwd,
      storagePath: lanceStoragePath(resolveMemoryRoot(cwd)),
      embedding,
    });
    opened.push(index);
    return { cwd, index };
  }
  const ids = async (index: LanceIndex, namespace = "default") =>
    (await index.search("x", { namespace, limit: 100 })).map((h) => h.id).sort();

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((i) => i.close()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("removes the fact's chunks, keeping other facts, namespaces, sources and other agents' indexes", async () => {
    const mine = await agentIndex();
    const theirs = await agentIndex(); // another agent, same ids
    for (const { index } of [mine, theirs]) {
      await index.addFacts([
        row("a:42#0"),
        row("a:42#1"),
        row("a:7#0", { fact_id: "a:7" }),
        row("a:42#0", { namespace: "t2" }),
        row("wiki-1", { source: "wiki" }),
      ]);
    }
    const manager = await managerWith([makeAdapter({ id: "a" })]);
    await buildAgentMemory(manager, mine.cwd, demoCtx).delete(mkMemoryId("a", "42"));
    expect(await ids(mine.index)).toEqual(["a:7#0", "wiki-1"]);
    expect(await ids(mine.index, "t2")).toEqual(["a:42#0"]);
    expect(await ids(theirs.index)).toEqual(["a:42#0", "a:42#1", "a:7#0", "wiki-1"]);
  });

  it("a sync whose add is still embedding cannot restore the fact after delete", async () => {
    const { cwd, index } = await agentIndex();
    const syncing = index.addFacts([row("a:42#0"), row("a:42#1")]);
    const manager = await managerWith([makeAdapter({ id: "a" })]);
    await buildAgentMemory(manager, cwd, demoCtx).delete(mkMemoryId("a", "42"));
    await syncing;
    expect(await ids(index)).toEqual([]);
  });

  it("uses the shared Lance namespace even when the context carries a tenantId", async () => {
    const { cwd, index } = await agentIndex();
    await index.addFacts([row("a:42#0"), row("a:7#0", { fact_id: "a:7" })]);
    const manager = await managerWith([makeAdapter({ id: "a" })]);
    await buildAgentMemory(manager, cwd, { userId: "demo", tenantId: "acme" }).delete(
      mkMemoryId("a", "42"),
    );
    expect(await ids(index)).toEqual(["a:7#0"]);
  });

  it("propagates a cleanup failure after the adapter already deleted", async () => {
    const { cwd } = await agentIndex();
    const deleted: MemoryId[] = [];
    const manager = await managerWith([makeAdapter({ id: "a", onDelete: (i) => deleted.push(i) })]);
    const spy = vi.spyOn(LanceIndex.prototype, "removeFacts").mockRejectedValue(new Error("boom"));
    try {
      await expect(
        buildAgentMemory(manager, cwd, demoCtx).delete(mkMemoryId("a", "42")),
      ).rejects.toThrow("boom");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(deleted).toEqual(["a:42"]);
    } finally {
      spy.mockRestore();
    }
  });
});
