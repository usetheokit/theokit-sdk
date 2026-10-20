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
import type { MemoryKind } from "../src/internal/memory/types.js";
import { type DreamingSweepResult, Memory } from "../src/memory.js";
import { removeTempDirRobust } from "./helpers/temp-workspace.js";

/*
 * B-380: the dreaming sweep clusters at most 500 deduplicated facts and used to drop the rest
 * while reporting `status: "ok"`. `factsLeftOut` says how many it left out.
 *
 * Both dispatch paths are exercised through the public `Memory.runDreamingSweep`, because the REM
 * phase exists twice (in this package and in `@theokit/sdk-memory`) and a fix to one copy must fail
 * here. From `packages/sdk` the loader cannot import `@theokit/sdk-memory` by name (there is no
 * package link), so the peer is injected: the loader is mocked to return a wrapper over the BUILT
 * peer whose `runDreamingSweep` is a spy over the real one. Every peer test asserts the spy ran once
 * and every fallback test that it never ran, so a test titled "peer" cannot silently run the
 * fallback. `pnpm build` must precede this file.
 */

vi.mock("../src/internal/memory/sdk-memory-peer-loader.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/internal/memory/sdk-memory-peer-loader.js")>();
  return { ...original, tryLoadSdkMemoryPeer: vi.fn() };
});

const SWEEP_TIMEOUT_MS = 60_000;
const DIMENSION = 600;

/** `fact number <i>` embeds as a one-hot vector at `vectorOf(i)`, so distinct facts never merge. */
function oneHotEmbedding(vectorOf: (i: number) => number = (i) => i): EmbeddingRuntime {
  return {
    id: "one-hot",
    model: "one-hot",
    dimension: DIMENSION,
    async embed(texts) {
      return texts.map((text) => {
        const match = /fact number (\d+)/.exec(text);
        const vector = new Array<number>(DIMENSION).fill(0);
        vector[match === null ? DIMENSION - 1 : vectorOf(Number(match[1]))] = 1;
        return vector;
      });
    },
    stats: () => ({ cacheHits: 0, cacheMisses: 0, httpCalls: 0, retries: 0 }),
  };
}

function failingEmbedding(): EmbeddingRuntime {
  return {
    ...oneHotEmbedding(),
    async embed() {
      throw new Error("embedding provider unavailable");
    },
  };
}

type Path = "peer" | "fallback";

let cwd: string;
let realPeer: SdkMemoryModule;
let wrapper: SdkMemoryModule & { runDreamingSweep: ReturnType<typeof vi.fn> };
let stub: EmbeddingRuntime;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "dreaming-left-out-"));
  onTestFinished(() => removeTempDirRobust(cwd));
  realPeer = (await import("../../sdk-memory/dist/index.js")) as unknown as SdkMemoryModule;
  stub = oneHotEmbedding();
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

function route(path: Path): void {
  vi.mocked(tryLoadSdkMemoryPeer).mockResolvedValue(path === "peer" ? wrapper : null);
}

/**
 * Distinct facts in the DEFAULT root: the peer's sweep takes no memory root and reads only that
 * one, so a custom directory would hand the peer test an empty store.
 */
async function seedFacts(count: number, kind?: MemoryKind): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await appendFactToMarkdown(cwd, { text: `fact number ${i}`, ...(kind ? { kind } : {}) });
  }
}

async function sweep(path: Path): Promise<DreamingSweepResult> {
  route(path);
  const result = await Memory.runDreamingSweep({ cwd, embedding: { provider: "ollama" } });
  expect(wrapper.runDreamingSweep).toHaveBeenCalledTimes(path === "peer" ? 1 : 0);
  wrapper.runDreamingSweep.mockClear();
  return result;
}

describe("the dreaming sweep reports the facts its cap left out", () => {
  it(
    "reports one fact left out of 501 through the sdk-memory peer",
    async () => {
      await seedFacts(501);
      const result = await sweep("peer");
      expect(result.status).toBe("ok");
      expect(result).toHaveProperty("factsLeftOut", 1);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "reports one fact left out of 501 through the fallback path",
    async () => {
      await seedFacts(501);
      const result = await sweep("fallback");
      expect(result.status).toBe("ok");
      expect(result).toHaveProperty("factsLeftOut", 1);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "reports zero left out at 500 facts",
    async () => {
      await seedFacts(500);
      for (const path of ["peer", "fallback"] as const) {
        const result = await sweep(path);
        expect(result.status).toBe("ok");
        expect(result).toHaveProperty("factsLeftOut", 0);
      }
    },
    SWEEP_TIMEOUT_MS,
  );

  it("omits factsLeftOut when the peer result does not carry it", async () => {
    await seedFacts(3);
    // The result an older `@theokit/sdk-memory` returns: the six fields it always had.
    const olderPeer = {
      ...realPeer,
      runDreamingSweep: async () => ({
        status: "ok" as const,
        factsBefore: 3,
        factsAfter: 3,
        duplicatesRemoved: 0,
        clustersCreated: 3,
        notesWritten: 1,
      }),
    };
    vi.mocked(tryLoadSdkMemoryPeer).mockResolvedValueOnce(olderPeer);
    const result = await Memory.runDreamingSweep({ cwd, embedding: { provider: "ollama" } });
    expect(result).not.toHaveProperty("factsLeftOut");
    expect(result.status).toBe("ok");
  });

  it("reports zero left out when the store is empty", async () => {
    for (const path of ["peer", "fallback"] as const) {
      const result = await sweep(path);
      expect(result.status).toBe("skipped");
      expect(result).toHaveProperty("factsLeftOut", 0);
    }
  });

  it("omits factsLeftOut when the sweep fails", async () => {
    await seedFacts(3);
    stub = failingEmbedding();
    for (const path of ["peer", "fallback"] as const) {
      const result = await sweep(path);
      expect(result.status).toBe("error");
      expect(result).not.toHaveProperty("factsLeftOut");
    }
  });

  it(
    "counts left-out facts after deduplication",
    async () => {
      // `project`, the kind both copies deduplicate by embedding: the fallback compares untyped
      // facts by text only, so an untyped fixture would never lose its shared-vector pair there.
      await seedFacts(502, "project");
      stub = oneHotEmbedding((i) => (i === 1 ? 0 : i));
      for (const path of ["peer", "fallback"] as const) {
        const result = await sweep(path);
        expect(result.duplicatesRemoved).toBe(1);
        expect(result).toHaveProperty("factsLeftOut", 1);
      }
    },
    SWEEP_TIMEOUT_MS,
  );
});
