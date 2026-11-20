import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isLanceAvailable, LanceIndex } from "../../../src/internal/memory/lance-index.js";

const embedding = {
  dimension: 2,
  embed: async (t: string[]) => {
    await new Promise((r) => setTimeout(r, 20));
    return t.map(() => [0.5, 0.5]);
  },
} as never;

const SCOPE = { namespace: "default", source: "memory" } as const;
const fact = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: id,
  source: "memory" as const,
  namespace: "default",
  scope: "agent",
  user_id: "u",
  timestamp: 0,
  ...extra,
});

const dirs: string[] = [];
const opened: LanceIndex[] = [];
async function open(dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "lance-rm-"));
  if (!dir) dirs.push(d);
  const index = await LanceIndex.open({ cwd: d, storagePath: d, embedding });
  opened.push(index);
  return { dir: d, index };
}
async function ids(index: LanceIndex, source?: "memory" | "wiki") {
  const hits = await index.search("x", { namespace: "default", limit: 100 });
  return hits
    .filter((h) => source === undefined || h.source === source)
    .map((h) => h.id)
    .sort();
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((i) => i.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!isLanceAvailable())("LanceIndex.removeFacts (real LanceDB)", () => {
  it("removes every chunk linked to the fact, but not an unrelated row named like a chunk", async () => {
    const { index } = await open();
    await index.addFacts([
      fact("f1"),
      fact("f1#0", { fact_id: "f1" }),
      fact("f1#1", { fact_id: "f1" }),
      fact("f1#2", { fact_id: "f1" }),
      fact("other#0", { fact_id: "other" }),
      fact("note-1"),
    ]);
    await index.addFacts([fact("f2#0")]); // independent fact that merely looks like a chunk name
    await index.removeFacts(["f1"], SCOPE);
    expect(await ids(index)).toEqual(["f2#0", "note-1", "other#0"]);
  });

  it("removing `f1` keeps an independent fact named `f1#0`", async () => {
    const { index } = await open();
    await index.addFacts([fact("f1"), fact("f1#0")]);
    await index.removeFacts(["f1"], SCOPE);
    expect(await ids(index)).toEqual(["f1#0"]);
  });

  it("without a scope removes only the exact id, as before, leaving linked chunks", async () => {
    const { index } = await open();
    await index.addFacts([
      fact("f1"),
      fact("f1#0", { fact_id: "f1" }),
      fact("f1", { source: "wiki" }),
      fact("keep"),
    ]);
    await index.removeFacts(["f1"]);
    expect(await ids(index)).toEqual(["f1#0", "keep"]);
  });

  it("keeps a row named like the fact but linked to another fact", async () => {
    const { index } = await open();
    await index.addFacts([fact("f1", { fact_id: "other" }), fact("f1#0", { fact_id: "f1" })]);
    await index.removeFacts(["f1"], SCOPE);
    expect(await ids(index)).toEqual(["f1"]);
  });

  it("a failed add does not block later adds and removals", async () => {
    let fail = true;
    const flaky = {
      dimension: 2,
      embed: async (t: string[]) => {
        if (fail) {
          fail = false;
          throw new Error("boom");
        }
        return t.map(() => [0.5, 0.5]);
      },
    } as never;
    const d = mkdtempSync(join(tmpdir(), "lance-rm-"));
    dirs.push(d);
    const index = await LanceIndex.open({ cwd: d, storagePath: d, embedding: flaky });
    opened.push(index);
    await expect(index.addFacts([fact("x")])).rejects.toThrow("boom");
    await index.addFacts([fact("f1#0", { fact_id: "f1" }), fact("keep")]);
    await index.removeFacts(["f1"], SCOPE);
    expect(await ids(index)).toEqual(["keep"]);
  });

  it("treats wildcard, quote and backslash characters in ids literally", async () => {
    const { index } = await open();
    await index.addFacts([
      fact("a_b#0", { fact_id: "a_b" }),
      fact("axb#0", { fact_id: "axb" }),
      fact("a%#0", { fact_id: "a%" }),
      fact("q'#0", { fact_id: "q'" }),
      fact("p\\q#0", { fact_id: "p\\q" }),
    ]);
    await index.removeFacts(["a_b", "a%", "q'", "p\\q"], SCOPE);
    expect(await ids(index)).toEqual(["axb#0"]);
  });

  it("keeps same-named rows of another source or namespace", async () => {
    const { index } = await open();
    await index.addFacts([
      fact("f1#0", { fact_id: "f1" }),
      fact("f1#1", { fact_id: "f1", source: "wiki" }),
      fact("f1#2", { fact_id: "f1", namespace: "other" }),
    ]);
    await index.removeFacts(["f1"], SCOPE);
    expect(await ids(index, "wiki")).toEqual(["f1#1"]);
    const other = await index.search("x", { namespace: "other" });
    expect(other.map((h) => h.id)).toEqual(["f1#2"]);
  });

  it("a removal issued during an in-flight add runs after it", async () => {
    const { index } = await open();
    const add = index.addFacts([
      fact("f1#0", { fact_id: "f1" }),
      fact("f1#1", { fact_id: "f1" }),
      fact("keep"),
    ]);
    const rm = index.removeFacts(["f1"], SCOPE);
    await Promise.all([add, rm]);
    expect(await ids(index)).toEqual(["keep"]);
  });

  it("a removal on one instance runs after an in-flight add on another on the same path", async () => {
    const a = await open();
    const b = await open(a.dir);
    const add = a.index.addFacts([fact("f1#0", { fact_id: "f1" }), fact("keep")]);
    const rm = b.index.removeFacts(["f1"], SCOPE);
    await Promise.all([add, rm]);
    expect(await ids(b.index)).toEqual(["keep"]);
  });

  it("an older table keeps its rows unlinked but links newly written chunks", async () => {
    const first = await open();
    const { dir } = first;
    await first.index.addFacts([fact("old"), fact("old#0"), fact("keep")]);
    const table = (
      first.index as unknown as { table: { dropColumns(c: string[]): Promise<unknown> } }
    ).table;
    await table.dropColumns(["fact_id"]);
    const { index } = await open(dir);
    await index.addFacts([fact("n#0", { fact_id: "n" }), fact("n#1", { fact_id: "n" })]);
    await index.removeFacts(["old", "n"], SCOPE);
    expect(await ids(index)).toEqual(["keep", "old#0"]);
  });
});
