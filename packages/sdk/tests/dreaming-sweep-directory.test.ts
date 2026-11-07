import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
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

/*
 * B-442: with @theokit/sdk-memory installed, `Memory.runDreamingSweep({ directory })` must read and
 * write `directory`, not `<cwd>/.theokit/memory`. The built peer is injected (see
 * dreaming-left-out.test.ts); `pnpm build` must precede this file.
 */

vi.mock("../src/internal/memory/sdk-memory-peer-loader.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/internal/memory/sdk-memory-peer-loader.js")>();
  return { ...original, tryLoadSdkMemoryPeer: vi.fn() };
});

const DIMENSION = 16;
const N = 5;

function oneHotEmbedding(): EmbeddingRuntime {
  return {
    id: "one-hot",
    model: "one-hot",
    dimension: DIMENSION,
    async embed(texts) {
      return texts.map((text) => {
        // Shared axis 0 plus a private axis: cosine 0.8, so facts cluster (>= 0.75) but never dedup (< 0.95).
        const n = Number(/fact number (\d+)/.exec(text)?.[1] ?? 0);
        const vector = new Array<number>(DIMENSION).fill(0);
        vector[0] = 1;
        vector[n + 1] = 0.5;
        return vector;
      });
    },
    stats: () => ({ cacheHits: 0, cacheMisses: 0, httpCalls: 0, retries: 0 }),
  };
}

let cwd: string;
let directory: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "dreaming-dir-cwd-"));
  directory = await mkdtemp(join(tmpdir(), "dreaming-dir-custom-"));
  onTestFinished(() => removeTempDirRobust(cwd));
  onTestFinished(() => removeTempDirRobust(directory));
  const realPeer = (await import("../../sdk-memory/dist/index.js")) as unknown as SdkMemoryModule;
  const stub = oneHotEmbedding();
  vi.mocked(tryLoadSdkMemoryPeer).mockResolvedValue({
    ...realPeer,
    MEMORY_EMBEDDING_ADAPTERS: {
      ollama: { id: "ollama", defaultModel: "stub", transport: "local", create: async () => stub },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSdkMemoryPeerCacheForTests();
});

async function seed(target: string | undefined): Promise<void> {
  for (let i = 0; i < N; i += 1) {
    await appendFactToMarkdown(cwd, { text: `fact number ${i}` }, target);
  }
}

const defaultRoot = (): string => join(cwd, ".theokit", "memory");

describe("the sdk-memory peer sweeps the configured memory directory", () => {
  it("reads facts seeded only in `directory`", async () => {
    await seed(directory);
    const result = await Memory.runDreamingSweep({
      cwd,
      directory,
      embedding: { provider: "ollama" },
    });
    expect(result.status).toBe("ok");
    expect(result.factsBefore).toBe(N);
  });

  it("writes the note and the diary under `directory` and nothing under the default root", async () => {
    await seed(directory);
    await Memory.runDreamingSweep({ cwd, directory, embedding: { provider: "ollama" } });
    expect(existsSync(defaultRoot())).toBe(false);
    expect(existsSync(join(directory, "dream-diary.md"))).toBe(true);
    const notes = await readdir(join(directory, "notes"));
    expect(notes.some((name) => name.startsWith("dreamed-"))).toBe(true);
  });

  it("without `directory` still reads and writes <cwd>/.theokit/memory", async () => {
    await seed(undefined);
    const result = await Memory.runDreamingSweep({ cwd, embedding: { provider: "ollama" } });
    expect(result.status).toBe("ok");
    expect(result.factsBefore).toBe(N);
    const notes = await readdir(join(defaultRoot(), "notes"));
    expect(notes.some((name) => name.startsWith("dreamed-"))).toBe(true);
    expect(existsSync(join(defaultRoot(), "dream-diary.md"))).toBe(true);
  });
});
