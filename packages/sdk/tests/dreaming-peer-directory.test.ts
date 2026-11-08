/**
 * B-442: with `@theokit/sdk-memory` installed, `Memory.runDreamingSweep({ directory })` reads and
 * writes the configured directory, not `<cwd>/.theokit/memory`. Offline; `pnpm build` must precede it.
 */
import { access, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { EmbeddingRuntime } from "../src/internal/memory/embedding-adapter.js";
import {
  resetSdkMemoryPeerCacheForTests,
  type SdkMemoryModule,
  tryLoadSdkMemoryPeer,
} from "../src/internal/memory/sdk-memory-peer-loader.js";
import { appendFactToMarkdown } from "../src/internal/memory/storage/markdown-store.js";
import { Memory } from "../src/memory.js";
import { removeTempDirRobust } from "./helpers/temp-workspace.js";

vi.mock("../src/internal/memory/sdk-memory-peer-loader.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/internal/memory/sdk-memory-peer-loader.js")>();
  return { ...original, tryLoadSdkMemoryPeer: vi.fn() };
});

const stub: EmbeddingRuntime = {
  id: "stub",
  model: "stub",
  dimension: 3,
  async embed(texts) {
    return texts.map((t) => (t.startsWith("alpha") ? [1, 0, 0] : [0, 1, 0]));
  },
  stats: () => ({ cacheHits: 0, cacheMisses: 0, httpCalls: 0, retries: 0 }),
};

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

async function temp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => removeTempDirRobust(d));
  return d;
}

async function seed(cwd: string, dir?: string): Promise<void> {
  for (const text of ["alpha one", "beta two", "gamma three"]) {
    await appendFactToMarkdown(cwd, { text, kind: "project" }, dir);
  }
}

beforeEach(async () => {
  const realPeer = (await import("../../sdk-memory/dist/index.js")) as unknown as SdkMemoryModule;
  const peer: SdkMemoryModule = {
    ...realPeer,
    MEMORY_EMBEDDING_ADAPTERS: {
      ollama: { id: "ollama", defaultModel: "stub", transport: "local", create: async () => stub },
    },
  };
  vi.mocked(tryLoadSdkMemoryPeer).mockResolvedValue(peer);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSdkMemoryPeerCacheForTests();
});

describe("peer dreaming sweep honours memory.directory", () => {
  it("reads facts seeded only in directory, and writes note and diary there", async () => {
    const cwd = await temp("dream-peer-cwd-");
    const directory = await temp("dream-peer-dir-");
    await seed(cwd, directory);
    const r = await Memory.runDreamingSweep({ cwd, directory, embedding: { provider: "ollama" } });
    expect(r.status).toBe("ok");
    expect(r.factsBefore).toBe(3);
    expect(await exists(join(directory, "dream-diary.md"))).toBe(true);
    expect((await readdir(join(directory, "notes"))).length).toBeGreaterThan(0);
    expect(await exists(join(cwd, ".theokit", "memory"))).toBe(false);
  });

  it("without directory still uses <cwd>/.theokit/memory", async () => {
    const cwd = await temp("dream-peer-default-");
    await seed(cwd);
    const r = await Memory.runDreamingSweep({ cwd, embedding: { provider: "ollama" } });
    expect(r.status).toBe("ok");
    expect(r.factsBefore).toBe(3);
    const root = join(cwd, ".theokit", "memory");
    expect(await exists(join(root, "dream-diary.md"))).toBe(true);
    expect((await readdir(join(root, "notes"))).length).toBeGreaterThan(0);
  });
});
