/**
 * #1068: the index stack has ONE copy.
 *
 * `Memory.openIndex` opens the index through this package whenever it is installed, so the
 * `IndexManager` exported here is the one that runs. It used to be a copy that had stopped
 * following the SDK's: when the FTS statement threw it returned `[]`, where the SDK falls back to a
 * LIKE scan and reports the fallback. Installing the package therefore turned a degraded search
 * into an empty one, with nothing said.
 *
 * `pnpm build` must precede this file: it imports the built packages, the way a consumer does.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDiagnosticsSink } from "@theokit/sdk";
import * as sdk from "@theokit/sdk/internal/memory-store";
import * as peer from "@theokit/sdk-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Removes the FTS table behind an open index, so its next `MATCH` statement throws. */
async function breakFts(cwd: string): Promise<void> {
  const db = await peer.openMemoryDb({
    filePath: peer.defaultIndexPath(peer.resolveMemoryRoot(cwd)),
  });
  try {
    db.exec("DROP TRIGGER chunks_fts_insert");
    db.exec("DROP TRIGGER chunks_fts_delete");
    db.exec("DROP TABLE chunks_fts");
  } finally {
    db.close();
  }
}

describe("the index stack: one copy shared by sdk and sdk-memory", () => {
  it("exports the SDK's IndexManager, not a copy of it", () => {
    expect(peer.IndexManager).toBe(sdk.IndexManager);
  });

  it("exports the SDK's dispatch, Lance index and migrations", () => {
    expect(peer.VALID_BACKENDS).toBe(sdk.VALID_BACKENDS);
    expect(peer.assertValidBackend).toBe(sdk.assertValidBackend);
    expect(peer.openLanceIndex).toBe(sdk.openLanceIndex);
    expect(peer.LanceIndex).toBe(sdk.LanceIndex);
    expect(peer.isLanceAvailable).toBe(sdk.isLanceAvailable);
    expect(peer.migrateSqliteToLance).toBe(sdk.migrateSqliteToLance);
    expect(peer.migrateLegacyJson).toBe(sdk.migrateLegacyJson);
    expect(peer.resetMigrationStateForTests).toBe(sdk.resetMigrationStateForTests);
    // `toBe(undefined)` on both sides would pass every line above.
    expect(typeof sdk.openLanceIndex).toBe("function");
    expect(typeof sdk.migrateLegacyJson).toBe("function");
  });

  it("keeps unwrap() on its Lance adapter and answers like the SDK's for the rest", async () => {
    const lance = {
      async search() {
        return [{ id: "f1", text: "typescript at work", source: "memory" as const, score: 0.5 }];
      },
      async close() {},
    } as unknown as sdk.LanceIndex;
    const adapter = new peer.LanceMemoryAdapter(lance);
    expect(adapter.unwrap()).toBe(lance);
    expect(await adapter.sync()).toMatchObject({ filesScanned: 0, supported: false });
    expect(adapter.status()).toMatchObject({ chunksIndexed: 0, countsExact: false });
    // The SDK's blend, 0.6 * vector + 0.4 * text: the one query term is in the text.
    const [hit] = await adapter.search("typescript");
    expect(hit?.textScore).toBe(1);
    expect(hit?.score).toBeCloseTo(0.6 * 0.5 + 0.4 * 1, 10);
  });
});

describe("IndexManager.search when the FTS statement throws", () => {
  let cwd: string;
  let messages: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sdk-memory-fts-fallback-"));
    const root = peer.resolveMemoryRoot(cwd);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "MEMORY.md"),
      "# Memory\n\n## Facts\n\n- The user likes pour-over coffee.\n- 記憶はマークダウンに保存される。\n",
    );
    messages = [];
    setDiagnosticsSink((message) => messages.push(message));
  });
  afterEach(async () => {
    setDiagnosticsSink(undefined);
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns the LIKE fallback hits and says so once, for a non-CJK query", async () => {
    const index = await peer.IndexManager.open({ cwd });
    try {
      await index.sync();
      await breakFts(cwd);

      const hits = await index.search("coffee");

      expect(hits.map((hit) => hit.path)).toEqual(["MEMORY.md"]);
      expect(hits[0]?.snippet).toContain("pour-over coffee");
      // LIKE has no relevance score: the neutral 0.5, blended with no vector half (0.4 * 0.5).
      expect(hits[0]?.textScore).toBe(0.5);
      const fallbacks = messages.filter((message) => message.includes("fell back to a LIKE scan"));
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]).toContain("chunks_fts");
    } finally {
      index.close();
    }
  });

  it("returns the LIKE fallback hits for a CJK query, without a diagnostic", async () => {
    const index = await peer.IndexManager.open({ cwd });
    try {
      await index.sync();
      await breakFts(cwd);

      const hits = await index.search("記憶");

      expect(hits).toHaveLength(1);
      expect(hits[0]?.snippet).toContain("記憶はマークダウンに保存される");
      expect(messages.filter((message) => message.includes("LIKE scan"))).toEqual([]);
    } finally {
      index.close();
    }
  });
});

describe("migrateLegacyJson: one per-process set of migrated keys", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sdk-memory-one-migration-set-"));
    peer.resetMigrationStateForTests();
  });
  afterEach(async () => {
    peer.resetMigrationStateForTests();
    await rm(cwd, { recursive: true, force: true });
  });

  it("a key attempted through this package is already-migrated through the SDK", async () => {
    const config = {
      enabled: true,
      namespace: "default",
      scope: "agent" as const,
      userId: "default",
    };

    const first = await peer.migrateLegacyJson(cwd, config);
    const second = await sdk.migrateLegacyJson(cwd, config);

    expect(first.reason).toBe("no-legacy-json");
    expect(second.reason).toBe("already-migrated");
  });
});
