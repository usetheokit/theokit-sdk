/** #1159: a CJK query finds its chunk in a healthy index, where FTS returns zero rows without throwing. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexManager } from "../../src/internal/memory/index-manager.js";
import { resolveMemoryRoot } from "../../src/internal/memory/storage/memory-root.js";

const CORPUS = [
  "# Memory",
  "",
  "- The user likes pour-over coffee.",
  "- 記憶はマークダウンに保存される。",
  "",
].join("\n");

describe("IndexManager.search over a healthy index", () => {
  let cwd: string | undefined;
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  async function open() {
    cwd = await mkdtemp(join(tmpdir(), "memory-cjk-"));
    await mkdir(resolveMemoryRoot(cwd), { recursive: true });
    await writeFile(join(resolveMemoryRoot(cwd), "MEMORY.md"), CORPUS);
    const index = await IndexManager.open({ cwd });
    await index.sync();
    return index;
  }

  it("returns the chunk containing a CJK substring", async () => {
    const index = await open();
    try {
      const hits = await index.search("記憶");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.snippet).toContain("記憶はマークダウンに保存される");
    } finally {
      await index.close();
    }
  });

  it("keeps a non-CJK query on FTS, scored by relevance rather than the LIKE midpoint", async () => {
    const index = await open();
    try {
      const hits = await index.search("coffee");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.textScore).not.toBe(0.5);
    } finally {
      await index.close();
    }
  });
});
