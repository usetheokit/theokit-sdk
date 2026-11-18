/**
 * #1206 — `agent.memory.delete` forgets the fact in the Lance index, scoped to its namespace, and a
 * sync that read the fact before the removal cannot restore it.
 */
import { describe, expect, it } from "vitest";

import { buildAgentMemory } from "../../../src/internal/local-agent/local-agent-memory-direct.js";
import { type LanceFactRecord, LanceIndex } from "../../../src/internal/memory/lance-index.js";
import { PluginManager } from "../../../src/internal/plugins/manager.js";
import { Plugin } from "../../../src/internal/plugins/types.js";
import { mkMemoryId } from "../../../src/memory-adapter-helpers.js";
import type { MemoryAdapter, MemoryId } from "../../../src/types/memory-adapter.js";

function makeLance(failDelete = false) {
  const rows: LanceFactRecord[] = [];
  const table = {
    add: async (r: LanceFactRecord[]) => {
      rows.push(...r);
    },
    delete: async (pred: string) => {
      if (failDelete) throw new Error("lance delete failed");
      const m =
        /^\(id = '([^']*)' OR starts_with\(id, '([^']*)'\)\) AND namespace = '([^']*)'$/.exec(pred);
      if (m === null) throw new Error(`unexpected predicate ${pred}`);
      const keep = rows.filter(
        (r) => !((r.id === m[1] || r.id.startsWith(m[2] ?? "")) && r.namespace === m[3]),
      );
      rows.splice(0, rows.length, ...keep);
    },
  };
  const Ctor = LanceIndex as unknown as new (t: unknown, e: unknown, d: number) => LanceIndex;
  const embed = async (t: string[]) => t.map(() => [0, 0]);
  const index = new Ctor(table, { dimension: 2, embed }, 2);
  return { index, rows };
}

const fact = (id: string, namespace = "default") => ({
  id,
  text: id,
  source: "memory" as const,
  namespace,
  scope: "s",
  user_id: "u",
  timestamp: 1,
});

async function memoryFor(index: LanceIndex, deleted: MemoryId[] = []) {
  const adapter: MemoryAdapter = {
    id: "a",
    capabilities: {
      history: false,
      sessions: false,
      tenancy: false,
      reasoning: false,
      toolSchemas: false,
      prefetch: false,
    },
    isAvailable: () => true,
    write: async () => mkMemoryId("a", "w"),
    recall: async () => [],
    delete: async (id) => {
      deleted.push(id);
    },
  };
  const manager = new PluginManager();
  await manager.initialize([
    Plugin.create({ name: "m", version: "1.0.0", kind: "memory", createProvider: () => adapter }),
  ]);
  return buildAgentMemory(manager, "/x", { userId: "u" }, (id) =>
    index.removeFactChunks(id, { namespace: "default" }),
  );
}

describe("agent.memory.delete → Lance cleanup", () => {
  it("removes every chunk of the fact in its namespace and nothing else", async () => {
    const { index, rows } = makeLance();
    await index.addFacts([
      fact("a:1#0"),
      fact("a:1#1"),
      fact("a:1"),
      fact("a:10#0"),
      fact("a:1#0", "other"),
      fact("a:2#0"),
    ]);
    await (await memoryFor(index)).delete(mkMemoryId("a", "1"));
    expect(rows.map((r) => `${r.namespace}/${r.id}`).sort()).toEqual([
      "default/a:10#0",
      "default/a:2#0",
      "other/a:1#0",
    ]);
  });

  it("surfaces a Lance cleanup failure instead of swallowing it", async () => {
    const { index, rows } = makeLance(true);
    await index.addFacts([fact("a:1#0")]);
    await expect((await memoryFor(index)).delete(mkMemoryId("a", "1"))).rejects.toThrow(
      "lance delete failed",
    );
    expect(rows).toHaveLength(1);
  });

  it("a sync that read the fact before the removal cannot restore it", async () => {
    const { index, rows } = makeLance();
    await index.addFacts([fact("a:1#0"), fact("a:2#0")]);
    const since = index.beginSync();
    const stale = [fact("a:1#0"), fact("a:1#1"), fact("a:2#1")]; // read before the forget
    await (await memoryFor(index)).delete(mkMemoryId("a", "1"));
    await index.addFacts(stale, { since }); // submitted only now, after the removal
    expect(rows.map((r) => r.id).sort()).toEqual(["a:2#0", "a:2#1"]);
  });

  it("a sync begun after the removal may write the fact again", async () => {
    const { index, rows } = makeLance();
    await (await memoryFor(index)).delete(mkMemoryId("a", "1"));
    const since = index.beginSync();
    await index.addFacts([fact("a:1#0")], { since });
    expect(rows).toHaveLength(1);
  });
});
