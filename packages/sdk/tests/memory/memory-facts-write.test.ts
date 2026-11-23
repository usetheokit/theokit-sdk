import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { addMemoryFact, listMemoryFacts, memoryPartitionId } from "../../src/index.js";
import { readFactsFromMarkdown } from "../../src/internal/memory/storage/markdown-store.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

function cwdDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mfw-"));
  onTestFinished(() => removeTempDirRobustSync(d));
  return d;
}

describe("addMemoryFact", () => {
  it("is listed for the same settings and absent from another user", async () => {
    const cwd = cwdDir();
    const a = { userId: memoryPartitionId("tenant a/ö") };
    const b = { userId: memoryPartitionId("tenant b") };
    await addMemoryFact(cwd, "the deploy key rotates monthly", a);
    expect((await listMemoryFacts(cwd, a)).map((f) => f.text)).toEqual([
      "the deploy key rotates monthly",
    ]);
    expect(await listMemoryFacts(cwd, b)).toEqual([]);
    // The store an agent created with these settings reads recall from.
    expect((await readFactsFromMarkdown(cwd, a)).map((f) => f.text)).toContain(
      "the deploy key rotates monthly",
    );
    expect((await readFactsFromMarkdown(cwd, b)).map((f) => f.text)).not.toContain(
      "the deploy key rotates monthly",
    );
  });

  it("honours maxFacts", async () => {
    const cwd = cwdDir();
    const s = { userId: "u1", maxFacts: 1 };
    await addMemoryFact(cwd, "one", s);
    await addMemoryFact(cwd, "two", s).catch(() => undefined);
    expect((await listMemoryFacts(cwd, s)).length).toBeLessThanOrEqual(1);
  });
});

describe("memoryPartitionId", () => {
  it("is deterministic, valid and distinct", () => {
    expect(memoryPartitionId("x")).toBe(memoryPartitionId("x"));
    expect(memoryPartitionId("x")).not.toBe(memoryPartitionId("y"));
    expect(memoryPartitionId("Any Thing/../")).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });
});
