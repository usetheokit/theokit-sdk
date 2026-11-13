/**
 * #1068: `Memory.openIndex` searches the same way with `@theokit/sdk-memory` installed and without.
 *
 * With the peer installed the index is opened through the peer's `IndexManager`. That used to be a
 * copy that had stopped following this package's: when the FTS statement threw, it returned `[]`
 * where this one falls back to a LIKE scan, which is what answers a CJK query FTS5 cannot. So
 * installing the peer turned LIKE matches into no matches, and nothing was reported.
 *
 * From `packages/sdk` the loader cannot import the peer by name (no package link), so the peer is
 * injected the way `dreaming-single-copy.test.ts` does it: the BUILT peer, with a spy on
 * `IndexManager.open` asserted to have run on the peer path and not on the fallback.
 * `pnpm build` must precede this file.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultIndexPath, openMemoryDb } from "../../src/internal/memory/index-db.js";
import type { MemorySearchHit } from "../../src/internal/memory/index-manager-contract.js";
import {
  resetSdkMemoryPeerCacheForTests,
  type SdkMemoryModule,
  tryLoadSdkMemoryPeer,
} from "../../src/internal/memory/sdk-memory-peer-loader.js";
import { resolveMemoryRoot } from "../../src/internal/memory/storage/memory-root.js";
import { Memory } from "../../src/memory.js";

vi.mock("../../src/internal/memory/sdk-memory-peer-loader.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/internal/memory/sdk-memory-peer-loader.js")>();
  return { ...original, tryLoadSdkMemoryPeer: vi.fn() };
});

const CORPUS = [
  "# Memory",
  "",
  "## Facts",
  "",
  "- The user likes pour-over coffee.",
  "- 記憶はマークダウンに保存される。",
  "- The deploy script restarts the workers.",
  "",
].join("\n");

const QUERIES = ["coffee", "記憶", "deploy script", "nothing matches this"] as const;

type Hits = Record<(typeof QUERIES)[number], ReadonlyArray<MemorySearchHit>>;

/** Removes the FTS table behind an open index, so its next `MATCH` statement throws. */
async function breakFts(cwd: string): Promise<void> {
  const db = await openMemoryDb({ filePath: defaultIndexPath(resolveMemoryRoot(cwd)) });
  try {
    db.exec("DROP TRIGGER chunks_fts_insert");
    db.exec("DROP TRIGGER chunks_fts_delete");
    db.exec("DROP TABLE chunks_fts");
  } finally {
    db.close();
  }
}

describe("Memory.openIndex search: the same hits with the sdk-memory peer and without", () => {
  let dirs: string[];
  let peer: SdkMemoryModule;
  let peerOpen: ReturnType<typeof vi.fn<SdkMemoryModule["IndexManager"]["open"]>>;

  beforeEach(async () => {
    dirs = [];
    const realPeer = (await import(
      "../../../sdk-memory/dist/index.js"
    )) as unknown as SdkMemoryModule;
    peerOpen = vi.fn((opts) => realPeer.IndexManager.open(opts));
    peer = { ...realPeer, IndexManager: { open: peerOpen } };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetSdkMemoryPeerCacheForTests();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  /** One fresh workspace holding the fixture corpus, searched through `Memory.openIndex`. */
  async function searchCorpus(mode: "peer" | "no-peer", ftsBroken: boolean): Promise<Hits> {
    const cwd = await mkdtemp(join(tmpdir(), `memory-parity-${mode}-`));
    dirs.push(cwd);
    await mkdir(resolveMemoryRoot(cwd), { recursive: true });
    await writeFile(join(resolveMemoryRoot(cwd), "MEMORY.md"), CORPUS);

    vi.mocked(tryLoadSdkMemoryPeer).mockResolvedValue(mode === "peer" ? peer : null);
    peerOpen.mockClear();
    const index = await Memory.openIndex({ cwd });
    // The comparison below means nothing unless the two modes really took different routes.
    expect(peerOpen).toHaveBeenCalledTimes(mode === "peer" ? 1 : 0);
    try {
      await index.sync();
      if (ftsBroken) await breakFts(cwd);
      const hits = {} as Hits;
      for (const query of QUERIES) hits[query] = await index.search(query);
      return hits;
    } finally {
      await index.close();
    }
  }

  it("returns the LIKE matches for a CJK query when the FTS statement throws", async () => {
    const withPeer = await searchCorpus("peer", true);
    const withoutPeer = await searchCorpus("no-peer", true);

    expect(withoutPeer.記憶.map((hit) => hit.snippet)).toEqual([
      expect.stringContaining("記憶はマークダウンに保存される"),
    ]);
    expect(withPeer.記憶).toEqual(withoutPeer.記憶);
    // Every other query degrades the same way too, including the one with no match.
    expect(withPeer).toEqual(withoutPeer);
    expect(withPeer.coffee).toHaveLength(1);
    expect(withPeer["nothing matches this"]).toEqual([]);
  });

  it("returns the same FTS hits over a healthy index", async () => {
    const withPeer = await searchCorpus("peer", false);
    const withoutPeer = await searchCorpus("no-peer", false);

    expect(withoutPeer.coffee).toHaveLength(1);
    expect(withoutPeer["deploy script"]).toHaveLength(1);
    expect(withPeer).toEqual(withoutPeer);
  });
});
