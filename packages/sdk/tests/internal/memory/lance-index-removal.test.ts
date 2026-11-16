import { describe, expect, it } from "vitest";

import { LanceIndex } from "../../../src/internal/memory/lance-index.js";

type Row = { id: string; source: string };

function makeIndex(embedDelay = 0, failFirstAdd = false) {
  const rows: Row[] = [];
  const log: string[] = [];
  const table = {
    add: async (r: Row[]) => {
      if (failFirstAdd && log.length === 0) {
        log.push("add-failed");
        throw new Error("boom");
      }
      log.push("add");
      rows.push(...r);
    },
    delete: async (pred: string) => {
      log.push("delete");
      // Minimal evaluator for `id = 'x'` / `id LIKE 'x#%'` joined by OR.
      const parts = pred.split(" OR ");
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] as Row;
        const hit = parts.some((p) => {
          const eq = /^id = '(.*)'$/.exec(p);
          if (eq) return row.id === (eq[1] as string).replace(/''/g, "'");
          const like = /^id LIKE '(.*)#%'$/.exec(p);
          if (!like) return false;
          const prefix = (like[1] as string).replace(/''/g, "'").replace(/\\(.)/g, "$1");
          return row.id.startsWith(`${prefix}#`);
        });
        if (hit) rows.splice(i, 1);
      }
    },
  };
  const embedding = {
    dimension: 2,
    embed: async (t: string[]) => {
      await new Promise((r) => setTimeout(r, embedDelay));
      return t.map(() => [0, 0]);
    },
  };
  const Ctor = LanceIndex as unknown as new (...a: unknown[]) => LanceIndex;
  return { index: new Ctor(table, embedding, 2), rows, log };
}

const fact = (id: string, source: "memory" | "wiki" = "memory") => ({
  id,
  text: id,
  source,
  namespace: "default",
  scope: "agent",
  user_id: "u",
  timestamp: 0,
});

describe("LanceIndex.removeFacts", () => {
  it("removes every chunk of the fact and leaves other rows", async () => {
    const { index, rows } = makeIndex();
    await index.addFacts(
      ["f1", "f1#0", "f1#1", "f1#2", "f10#0", "f1x", "note-1"].map((i) => fact(i)),
    );
    await index.addFacts([fact("w1", "wiki")]);
    await index.removeFacts(["f1"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["f10#0", "f1x", "note-1", "w1"]);
  });

  it("does not treat LIKE wildcards in an id as patterns", async () => {
    const { index, rows } = makeIndex();
    await index.addFacts([fact("a_b#0"), fact("axb#0"), fact("a%#0"), fact("q'#0")]);
    await index.removeFacts(["a_b", "a%", "q'"]);
    expect(rows.map((r) => r.id)).toEqual(["axb#0"]);
  });

  it("a removal issued during an in-flight add runs after it", async () => {
    const { index, rows, log } = makeIndex(30);
    const add = index.addFacts([fact("f1#0"), fact("f1#1"), fact("keep")]);
    const rm = index.removeFacts(["f1"]);
    await Promise.all([add, rm]);
    expect(log).toEqual(["add", "delete"]);
    expect(rows.map((r) => r.id)).toEqual(["keep"]);
  });

  it("a failed add does not block later removals", async () => {
    const { index, rows } = makeIndex(0, true);
    await expect(index.addFacts([fact("x#0")])).rejects.toThrow("boom");
    await index.addFacts([fact("f1#0"), fact("keep")]);
    await index.removeFacts(["f1"]);
    expect(rows.map((r) => r.id)).toEqual(["keep"]);
  });
});
