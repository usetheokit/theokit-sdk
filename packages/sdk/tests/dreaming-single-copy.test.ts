/**
 * B-444: the dreaming sweep has ONE implementation. `Memory.runDreamingSweep` must report the same
 * `factsBefore`, `duplicatesRemoved` and `factsLeftOut` with `@theokit/sdk-memory` installed and
 * without it, over the same seeded facts. Offline: the embedding adapters are stubbed.
 *
 * From `packages/sdk` the loader cannot import the peer by name (no package link), so the peer is
 * injected the way `dreaming-left-out.test.ts` does it: a wrapper over the BUILT peer whose
 * `runDreamingSweep` is a spy, asserted to have run on the peer path and not on the fallback.
 * `pnpm build` must precede this file.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { MEMORY_EMBEDDING_ADAPTERS } from "../src/internal/memory/adapters/catalog.js";
import type { EmbeddingRuntime } from "../src/internal/memory/embedding-adapter.js";
import {
  resetSdkMemoryPeerCacheForTests,
  type SdkMemoryModule,
  tryLoadSdkMemoryPeer,
} from "../src/internal/memory/sdk-memory-peer-loader.js";
import { appendFactToMarkdown } from "../src/internal/memory/storage/markdown-store.js";
import { type DreamingSweepResult, Memory } from "../src/memory.js";
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

async function seed(cwd: string): Promise<void> {
  await appendFactToMarkdown(cwd, { text: "alpha one", kind: "project" });
  await appendFactToMarkdown(cwd, { text: "alpha two", kind: "project" }); // near-duplicate
  await appendFactToMarkdown(cwd, { text: "beta three", kind: "project" });
  // Protected kind: the SDK's policy never dedups it; a stale copy of the phases would.
  await appendFactToMarkdown(cwd, { text: "alpha correction", kind: "feedback" });
  await appendFactToMarkdown(cwd, { text: "alpha correction again", kind: "feedback" });
}

const counts = (r: DreamingSweepResult) => ({
  factsBefore: r.factsBefore,
  duplicatesRemoved: r.duplicatesRemoved,
  factsLeftOut: r.factsLeftOut,
});

let wrapper: SdkMemoryModule & { runDreamingSweep: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  const realPeer = (await import("../../sdk-memory/dist/index.js")) as unknown as SdkMemoryModule;
  wrapper = {
    ...realPeer,
    MEMORY_EMBEDDING_ADAPTERS: {
      ollama: { id: "ollama", defaultModel: "stub", transport: "local", create: async () => stub },
    },
    runDreamingSweep: vi.fn(realPeer.runDreamingSweep),
  };
  const fallbackOllama = MEMORY_EMBEDDING_ADAPTERS.ollama;
  if (fallbackOllama === undefined) throw new Error("the fallback catalog has no ollama adapter");
  vi.spyOn(fallbackOllama, "create").mockImplementation(async () => stub);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSdkMemoryPeerCacheForTests();
});

describe("the dreaming sweep: with and without @theokit/sdk-memory", () => {
  it("reports the same counts over the same seeded facts on both paths", async () => {
    const results: DreamingSweepResult[] = [];
    for (const withPeer of [true, false]) {
      const cwd = await mkdtemp(join(tmpdir(), "dreaming-single-copy-"));
      onTestFinished(() => removeTempDirRobust(cwd));
      await seed(cwd);
      vi.mocked(tryLoadSdkMemoryPeer).mockResolvedValue(withPeer ? wrapper : null);
      results.push(await Memory.runDreamingSweep({ cwd, embedding: { provider: "ollama" } }));
      expect(wrapper.runDreamingSweep).toHaveBeenCalledTimes(withPeer ? 1 : 0);
      wrapper.runDreamingSweep.mockClear();
    }
    const [withPeer, without] = results as [DreamingSweepResult, DreamingSweepResult];
    expect(withPeer.status).toBe("ok");
    expect(counts(withPeer)).toEqual(counts(without));
    expect(counts(without)).toEqual({ factsBefore: 5, duplicatesRemoved: 1, factsLeftOut: 0 });
  });
});
