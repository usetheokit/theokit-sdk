import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendFact,
  readFacts,
} from "../src/internal/memory/storage/markdown-store.js";
import {
  projectMemoryDir,
  resolveMemoryRoot,
} from "../src/internal/memory/storage/memory-root.js";
import type { MemoryFact } from "../src/internal/memory/types.js";

const fact = (text: string): MemoryFact => ({ text, createdAt: Date.now() }) as MemoryFact;

describe("memory.userId isolates facts (#1025)", () => {
  it("one user's facts are not read by another user sharing the cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mem-user-"));
    const a = { enabled: true, userId: "a" };
    const b = { enabled: true, userId: "b" };
    await appendFact(cwd, a, fact("alice likes violet tea"));
    expect((await readFacts(cwd, a)).map((f) => f.text).join("\n")).toContain("violet tea");
    expect(await readFacts(cwd, b)).toEqual([]);
  });

  it("without userId, facts under <cwd>/.theokit/memory are still read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mem-user-"));
    const plain = { enabled: true };
    await appendFact(cwd, plain, fact("shared project fact"));
    expect(resolveMemoryRoot(cwd, plain)).toBe(projectMemoryDir(cwd));
    expect((await readFacts(cwd, plain)).map((f) => f.text).join("\n")).toContain("shared project");
    // a user partition does not fall back to the shared store
    expect(await readFacts(cwd, { enabled: true, userId: "a" })).toEqual([]);
  });

  it("userId is confined to the memory root", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mem-user-"));
    expect(() => resolveMemoryRoot(cwd, { enabled: true, userId: "../x" })).toThrow(
      /invalid/i,
    );
    const root = resolveMemoryRoot(cwd, { enabled: true, userId: "alice" });
    expect(relative(projectMemoryDir(cwd), root)).toBe(join("users", "alice"));
  });
});
