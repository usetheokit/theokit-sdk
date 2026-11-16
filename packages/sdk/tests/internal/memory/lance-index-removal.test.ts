import { describe, expect, it } from "vitest";

import { LanceIndex } from "../../../src/internal/memory/lance-index.js";

type Row = { id: string; source: string; namespace: string };

function makeTable(rows: Row[], log: string[], failFirstAdd = false) {
  // Minimal evaluator for the predicates removeFacts builds.
  const matches = (row: Row, pred: string): boolean =>
    pred
      .replace(/^\((.*)\) AND /, "$1 AND ")
      .split(" AND ")
      .every((clause) => {
        const ns = /^namespace = '(.*)'$/.exec(clause);
        if (ns) return row.namespace === ns[1];
        const src = /^source = '(.*)'$/.exec(clause);
        if (src) return row.source === src[1];
        return clause.split(" OR ").some((p) => {
          const eq = /^\(?id = '(.*?)'\)?$/.exec(p);
          if (eq) return row.id === (eq[1] as string).replace(/''/g, "'");
          const like = /^\(?id LIKE '(.*)#%'\)?$/.exec(p);
          if (!like) return false;
          const prefix = (like[1] as string).replace(/''/g, "'").replace(/\\(.)/g, "$1");
          return row.id.startsWith(`${prefix}#`);
        });
      });
  return {
    add: async (r: Row[]) => {
      if (failFirstAdd && log.length === 0) {
        log.push("add-failed");
        throw new Error("boom");
      }
      log.push("add");
      rows.push(...r);
    },
    query: () => {
      let pred = "";
      const q = {
        where: (p: string) => {
          pred = p;
          return q;
        },
        select: () => q,
        toArray: async () => rows.filter((r) => matches(r, pred)),
      };
      return q;
    },
    delete: async (pred: string) => {
      log.push("delete");
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i] as Row, pred)) rows.splice(i, 1);
      }
    },
  };
}

let keyCounter = 0;
function makeIndex(embedDelay = 0, failFirstAdd = false, key?: string, rowsIn?: Row[]) {
  const rows: Row[] = rowsIn ?? [];
  const log: string[] = [];
  const table = makeTable(rows, log, failFirstAdd);
  const embedding = {
    dimension: 2,
    embed: async (t: string[]) => {
      await new Promise((r) => setTimeout(r, embedDelay));
      return t.map(() => [0, 0]);
    },
  };
  const Ctor = LanceIndex as unknown as new (...a: unknown[]) => LanceIndex;
  return { index: new Ctor(table, embedding, 2, key ?? `test-${keyCounter++}`), rows, log };
}

const SCOPE = { namespace: "default", source: "memory" } as const;
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
    await index.removeFacts(["f1"], SCOPE);
    expect(rows.map((r) => r.id).sort()).toEqual(["f10#0", "f1x", "note-1", "w1"]);
  });

  it("does not treat LIKE wildcards in an id as patterns", async () => {
    const { index, rows } = makeIndex();
    await index.addFacts([fact("a_b#0"), fact("axb#0"), fact("a%#0"), fact("q'#0")]);
    await index.removeFacts(["a_b", "a%", "q'"], SCOPE);
    expect(rows.map((r) => r.id)).toEqual(["axb#0"]);
  });

  it("a removal issued during an in-flight add runs after it", async () => {
    const { index, rows, log } = makeIndex(30);
    const add = index.addFacts([fact("f1#0"), fact("f1#1"), fact("keep")]);
    const rm = index.removeFacts(["f1"], SCOPE);
    await Promise.all([add, rm]);
    expect(log).toEqual(["add", "delete"]);
    expect(rows.map((r) => r.id)).toEqual(["keep"]);
  });

  it("a failed add does not block later removals", async () => {
    const { index, rows } = makeIndex(0, true);
    await expect(index.addFacts([fact("x#0")])).rejects.toThrow("boom");
    await index.addFacts([fact("f1#0"), fact("keep")]);
    await index.removeFacts(["f1"], SCOPE);
    expect(rows.map((r) => r.id)).toEqual(["keep"]);
  });

  it("keeps `<id>#other` rows that are not numbered chunks", async () => {
    const { index, rows } = makeIndex();
    await index.addFacts([fact("f1#0"), fact("f1#other"), fact("f1#1#x")]);
    await index.removeFacts(["f1"], SCOPE);
    expect(rows.map((r) => r.id).sort()).toEqual(["f1#1#x", "f1#other"]);
  });

  it("an ordinary removal keeps a wiki row and another namespace that share the id", async () => {
    const { index, rows } = makeIndex();
    await index.addFacts([fact("f1"), fact("f1", "wiki"), { ...fact("f1"), namespace: "other" }]);
    await index.removeFacts(["f1"], SCOPE);
    expect(rows.map((r) => `${r.namespace}/${r.source}`).sort()).toEqual([
      "default/wiki",
      "other/memory",
    ]);
  });

  it("scope keeps same-named rows of another source or namespace", async () => {
    const { index, rows } = makeIndex();
    await index.addFacts([
      fact("f1#0"),
      fact("f1#1", "wiki"),
      { ...fact("f1#2"), namespace: "other" },
    ]);
    await index.removeFacts(["f1"], SCOPE);
    expect(rows.map((r) => r.id).sort()).toEqual(["f1#1", "f1#2"]);
  });

  it("a removal on one instance runs after an in-flight add on another on the same path", async () => {
    const shared: Row[] = [];
    const slow = makeIndex(30, false, "same-path", shared);
    const other = makeIndex(0, false, "same-path", shared);
    const add = slow.index.addFacts([fact("f1#0"), fact("keep")]);
    const rm = other.index.removeFacts(["f1"], SCOPE);
    await Promise.all([add, rm]);
    expect(shared.map((r) => r.id)).toEqual(["keep"]);
  });
});
