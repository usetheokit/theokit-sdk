/**
 * #1206 — `agent.memory.delete` forgets the fact in every open Lance index, scoped to its namespace
 * and source, and a sync that read the fact before the removal cannot restore it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../../../src/agent.js";
import {
  forgetFactInOpenIndexes,
  type IndexedFact,
  type LanceFactRecord,
  LanceIndex,
} from "../../../src/internal/memory/lance-index.js";
import { Plugin } from "../../../src/internal/plugins/types.js";
import { mkMemoryId } from "../../../src/memory-adapter-helpers.js";
import type { AgentOptions } from "../../../src/types/agent.js";
import type { MemoryAdapter } from "../../../src/types/memory-adapter.js";
import { useTempCwd } from "../../helpers/temp-workspace.js";

useTempCwd();

const eq = (pred: string, col: string) =>
  new RegExp(`${col} = '((?:[^']|'')*)'`).exec(pred)?.[1]?.replace(/''/g, "'");

/** In-memory stand-in for the Lance table: understands exactly the predicates the index builds. */
function makeLance(opts: { failDelete?: boolean; gate?: Promise<void> } = {}) {
  const rows: LanceFactRecord[] = [];
  const table = {
    add: async (r: LanceFactRecord[]) => {
      await opts.gate;
      rows.push(...r);
    },
    delete: async (pred: string) => {
      if (opts.failDelete) throw new Error("lance delete failed");
      const idEq = /^\(id = '((?:[^']|'')*)' OR starts_with\(id, '((?:[^']|'')*)'\)\)/.exec(pred);
      if (idEq === null) throw new Error(`unexpected predicate ${pred}`);
      const [exact, prefix] = [idEq[1], idEq[2]];
      const ns = eq(pred, "namespace");
      const src = eq(pred, "source");
      const keep = rows.filter(
        (r) =>
          !(
            (r.id === exact || r.id.startsWith(prefix ?? "\0")) &&
            (ns === undefined || r.namespace === ns) &&
            r.source === src
          ),
      );
      rows.splice(0, rows.length, ...keep);
    },
    search: () => {
      let ns = "";
      const q = {
        where: (f: string) => {
          ns = eq(f, "namespace") ?? "";
          return q;
        },
        limit: () => q,
        toArray: async () => rows.filter((r) => r.namespace === ns),
      };
      return q;
    },
  };
  const Ctor = LanceIndex as unknown as new (t: unknown, e: unknown, d: number) => LanceIndex;
  const embed = async (t: string[]) => t.map(() => [0, 0]);
  const index = new Ctor(table, { dimension: 2, embed }, 2);
  return { index, rows };
}

const fact = (id: string, over: Partial<IndexedFact> = {}): IndexedFact => ({
  id,
  chunks: ["c0", "c1"],
  namespace: "default",
  scope: "s",
  user_id: "u",
  timestamp: 1,
  ...over,
});

const ids = (rows: LanceFactRecord[]) =>
  rows.map((r) => `${r.namespace}/${r.source}/${r.id}`).sort();

const opened: LanceIndex[] = [];
afterEach(async () => {
  for (const i of opened.splice(0)) await i.close();
});
function open(o?: Parameters<typeof makeLance>[0]) {
  const l = makeLance(o);
  opened.push(l.index);
  return l;
}

/** An adapter whose store is the Lance index, so recall shows what the index still holds. */
function lanceAdapter(index: LanceIndex): MemoryAdapter {
  return {
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
    recall: async (q) =>
      (await index.search(q, { namespace: "default" })).map((h) => ({
        id: h.id as never,
        content: h.text,
      })),
    delete: async () => {},
  };
}

async function agentFor(index: LanceIndex) {
  return Agent.create({
    apiKey: "theo_test_forget_lance",
    model: { id: "openai/gpt-4o-mini" },
    local: {},
    memoryContext: { userId: "u" },
    plugins: [
      Plugin.create({
        name: "m",
        version: "1.0.0",
        kind: "memory",
        createProvider: () => lanceAdapter(index),
      }),
    ] as unknown as AgentOptions["plugins"],
  });
}

describe("agent.memory.delete → Lance cleanup (real agent)", () => {
  it("a deleted fact no longer comes back from recall; others do", async () => {
    const { index } = open();
    await index.indexFact(fact("a:1", { chunks: ["one"] }));
    await index.indexFact(fact("a:2", { chunks: ["two"] }));
    const agent = await agentFor(index);
    try {
      expect((await agent.memory!.recall("x", { userId: "u" })).length).toBe(2);
      await agent.memory!.delete(mkMemoryId("a", "1"));
      const left = await agent.memory!.recall("x", { userId: "u" });
      expect(left.map((f) => f.content)).toEqual(["two"]);
    } finally {
      await agent.dispose();
    }
  });

  it("an index removal failure reaches the caller", async () => {
    const { index } = open({ failDelete: true });
    await index.indexFact(fact("a:1"));
    const agent = await agentFor(index);
    try {
      await expect(agent.memory!.delete(mkMemoryId("a", "1"))).rejects.toThrow(
        "lance delete failed",
      );
    } finally {
      await agent.dispose();
    }
  });
});

describe("LanceIndex.removeFactChunks", () => {
  it("removes every chunk of the fact in every namespace and leaves prefix-sharing facts and other sources", async () => {
    const { index, rows } = open();
    await index.indexFact(fact("a"));
    await index.indexFact(fact("a#b")); // id has the chunk separator, must not match 'a'
    await index.indexFact(fact("a", { source: "wiki" }));
    await index.indexFact(fact("a", { namespace: "other" }));
    await forgetFactInOpenIndexes("a");
    expect(ids(rows)).toEqual([
      "default/memory/a%23b#0",
      "default/memory/a%23b#1",
      "default/wiki/a#0",
      "default/wiki/a#1",
    ]);
  });

  it("an explicit namespace scope leaves the same fact in other namespaces alone", async () => {
    const { index, rows } = open();
    await index.indexFact(fact("a"));
    await index.indexFact(fact("a", { namespace: "other" }));
    await index.removeFactChunks("a", { namespace: "other", source: "memory" });
    expect(ids(rows)).toEqual(["default/memory/a#0", "default/memory/a#1"]);
  });

  it("is a no-op, not an error, when no index is open", async () => {
    await expect(forgetFactInOpenIndexes("a")).resolves.toBeUndefined();
  });
});

describe("sync vs. removal", () => {
  it("a sync paused after reading its facts cannot restore a fact removed meanwhile", async () => {
    const { index, rows } = open();
    await index.indexFact(fact("a:2"));
    let release!: () => void;
    const paused = new Promise<void>((r) => {
      release = r;
    });
    let readDone!: () => void;
    const read = new Promise<void>((r) => {
      readDone = r;
    });
    const sync = index.syncFacts(async () => {
      const facts = [fact("a:1"), fact("a:3")]; // read before the forget
      readDone();
      await paused;
      return facts;
    });
    await read; // the sync has read its facts and is paused
    await forgetFactInOpenIndexes("a:1");
    release();
    await sync;
    expect(ids(rows)).toEqual([
      "default/memory/a:2#0",
      "default/memory/a:2#1",
      "default/memory/a:3#0",
      "default/memory/a:3#1",
    ]);
  });

  it("a sync begun after the removal may write the fact again", async () => {
    const { index, rows } = open();
    await forgetFactInOpenIndexes("a:1");
    await index.syncFacts(async () => [fact("a:1")]);
    expect(rows).toHaveLength(2);
  });
});
