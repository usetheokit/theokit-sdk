import { describe, expect, it } from "vitest";

import { type LanceFactRecord, LanceIndex } from "../../../src/internal/memory/lance-index.js";

function makeIndex(embed: (t: string[]) => Promise<number[][]>) {
  const rows: LanceFactRecord[] = [];
  const predicates: string[] = [];
  const table = {
    add: async (r: LanceFactRecord[]) => {
      rows.push(...r);
    },
    delete: async (pred: string) => {
      predicates.push(pred);
      const m = /^id IN \((.*)\)(?: AND namespace = '([^']*)')?(?: AND source = '([^']*)')?$/.exec(
        pred,
      );
      if (m === null) return;
      const ids = (m[1] ?? "").split(", ").map((x) => x.slice(1, -1));
      const keep = rows.filter(
        (r) =>
          !(
            ids.includes(r.id) &&
            (m[2] === undefined || r.namespace === m[2]) &&
            (m[3] === undefined || r.source === m[3])
          ),
      );
      rows.splice(0, rows.length, ...keep);
    },
  };
  const Ctor = LanceIndex as unknown as new (t: unknown, e: unknown, d: number) => LanceIndex;
  const index = new Ctor(table, { dimension: 2, embed }, 2);
  return { index, rows, predicates };
}

const fact = (id: string, namespace = "ns", source: LanceFactRecord["source"] = "memory") => ({
  id,
  text: id,
  source,
  namespace,
  scope: "s",
  user_id: "u",
  timestamp: 1,
});

describe("LanceIndex.removeFacts", () => {
  it("removes all chunks of a fact within namespace and source only", async () => {
    const { index, rows } = makeIndex(async (t) => t.map(() => [0, 0]));
    await index.addFacts([
      fact("a1"),
      fact("a2"),
      fact("a1", "other"),
      fact("a1", "ns", "wiki"),
      fact("keep"),
    ]);
    await index.removeFacts(["a1", "a2"], { namespace: "ns", source: "memory" });
    expect(rows.map((r) => `${r.namespace}/${r.source}/${r.id}`).sort()).toEqual([
      "ns/memory/keep",
      "ns/wiki/a1",
      "other/memory/a1",
    ]);
  });

  it("keeps the unscoped removeFacts(ids) form working", async () => {
    const { index, rows } = makeIndex(async (t) => t.map(() => [0, 0]));
    await index.addFacts([fact("a"), fact("a", "other"), fact("b")]);
    await index.removeFacts(["a"]);
    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("an in-flight addFacts cannot resurrect removed facts", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { index, rows } = makeIndex(async (t) => {
      await gate;
      return t.map(() => [0, 0]);
    });
    const add = index.addFacts([fact("x1"), fact("x2")]);
    const remove = index.removeFacts(["x1", "x2"], { namespace: "ns" });
    release();
    await Promise.all([add, remove]);
    expect(rows).toEqual([]);
  });

  it("a failed write does not block later removals", async () => {
    let fail = true;
    const { index, rows } = makeIndex(async (t) => {
      if (fail) throw new Error("embed down");
      return t.map(() => [0, 0]);
    });
    await expect(index.addFacts([fact("z")])).rejects.toThrow("embed down");
    fail = false;
    await index.addFacts([fact("z")]);
    await index.removeFacts(["z"]);
    expect(rows).toEqual([]);
  });

  it("escapes quotes in ids and scope", async () => {
    const { index, predicates } = makeIndex(async (t) => t.map(() => [0, 0]));
    await index.removeFacts(["a'b"], { namespace: "n'x" });
    expect(predicates[0]).toBe("id IN ('a''b') AND namespace = 'n''x'");
  });
});
