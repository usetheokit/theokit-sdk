import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetFact } from "../../src/internal/memory/storage/forget-fact.js";
import { appendFact } from "../../src/internal/memory/storage/markdown-store.js";

describe("forgetFact", () => {
  let cwd: string;
  const cfg = { enabled: true } as never;
  const dir = () => join(cwd, ".theokit", "memory");

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-forget-"));
  });
  afterEach(async () => rm(cwd, { recursive: true, force: true }));

  it("removes the file and index line, then the scoped index rows", async () => {
    await appendFact(cwd, cfg, { text: "The billing service runs on port 8080" });
    await appendFact(cwd, cfg, { text: "Deploys happen on Fridays" });
    const name = (await readdir(dir())).find((n) => n.startsWith("billing"))?.replace(/\.md$/, "");
    expect(name).toBeDefined();
    const calls: unknown[] = [];
    const lance = {
      removeFacts: async (ids: ReadonlyArray<string>, scope?: unknown) => {
        calls.push([ids, scope]);
      },
    };
    expect(await forgetFact(cwd, cfg, name as string, { lance, namespace: "ns" })).toBe(true);
    expect(await readdir(dir())).not.toContain(`${name}.md`);
    const index = await readFile(join(dir(), "MEMORY.md"), "utf8");
    expect(index).not.toContain(`](${name}.md)`);
    expect(index).toContain("Deploys");
    expect(calls).toEqual([[[name], { namespace: "ns", source: "memory" }]]);
  });

  it("does not touch the index when nothing was forgotten", async () => {
    let called = false;
    const lance = {
      removeFacts: async () => {
        called = true;
      },
    };
    expect(await forgetFact(cwd, cfg, "missing", { lance, namespace: "ns" })).toBe(false);
    expect(called).toBe(false);
  });

  it("refuses a name that is not a plain slug", async () => {
    expect(await forgetFact(cwd, cfg, "../escape")).toBe(false);
  });
});
