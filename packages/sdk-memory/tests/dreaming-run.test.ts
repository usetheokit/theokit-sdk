/**
 * sdk-memory `dreaming-run` unit test (iter 60).
 *
 * Validates the iter 60 hybrid copy of
 * `internal/memory/dreaming/run.ts` from sdk-core. sdk-memory now
 * ships the canonical dreaming sweep orchestrator (ADR D7) that
 * composes all 4 sibling moves from iter 45/54/56/59.
 *
 * sdk-core retains its copy for v1.x dreaming back-compat.
 * Both copies byte-equivalent at runtime (same 3-phase
 * light/REM/deep composition, same dreamed-<ts>.md notes file
 * naming, same per-cwd mutex wrap, same swallow-with-stderr-warn
 * failure semantics).
 *
 * Uses temp-dir + real file I/O + stub EmbeddingRuntime (no LLM
 * calls; deterministic vectors).
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDiagnosticsSink } from "@theokit/sdk";
import {
  appendFactToMarkdown,
  type DreamingResult,
  type EmbeddingRuntime,
  resolveMemoryRoot,
  runDreamingSweep,
} from "@theokit/sdk-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function stubEmbedding(textToVec: Record<string, ReadonlyArray<number>>): EmbeddingRuntime {
  return {
    embed: async (texts: ReadonlyArray<string>): Promise<number[][]> =>
      texts.map((t) => [...(textToVec[t] ?? [0.5, 0.5, 0.5])]),
    dimension: 3,
    providerId: "stub",
    model: "stub-model",
  } as unknown as EmbeddingRuntime;
}

describe("sdk-memory dreaming-run (iter 60)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sdk-memory-dream-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("test_skipped_status_when_no_facts_in_memory", async () => {
    const embedding = stubEmbedding({});
    const result: DreamingResult = await runDreamingSweep({ cwd, embedding });
    expect(result.status).toBe("skipped");
    expect(result.factsBefore).toBe(0);
    expect(result.factsAfter).toBe(0);
    expect(result.notesWritten).toBe(0);
  });

  it("test_ok_status_dedup_cluster_write_dream_note", async () => {
    // Two near-duplicate facts about AI + one about Go → 1 cluster
    // after dedup (Go drops because only 1 in its cluster — wait, Go
    // also forms its own singleton cluster; remPhase keeps singletons).
    await appendFactToMarkdown(cwd, { text: "ai short", kind: "project" });
    await appendFactToMarkdown(cwd, { text: "ai longer description", kind: "project" });
    await appendFactToMarkdown(cwd, { text: "go runtime quirks", kind: "project" });

    const embedding = stubEmbedding({
      "ai short": [1, 0, 0],
      "ai longer description": [0.95, 0.05, 0], // cosine ≈ 0.995 → dedup
      "go runtime quirks": [0, 1, 0], // orthogonal → keep
    });

    const result = await runDreamingSweep({
      cwd,
      embedding,
      now: () => Date.UTC(2026, 0, 1, 12, 0, 0),
    });
    expect(result.status).toBe("ok");
    expect(result.factsBefore).toBe(3);
    expect(result.factsAfter).toBe(2); // one ai dedup'd
    expect(result.duplicatesRemoved).toBe(1);
    // clustersCreated reflects post-dedup remPhase grouping; with 2
    // orthogonal kept vectors this is 2 singleton clusters.
    expect(result.clustersCreated).toBe(2);
    expect(result.notesWritten).toBe(1);

    // Verify notes file was created.
    const notesDir = join(resolveMemoryRoot(cwd), "notes");
    const entries = await readdir(notesDir);
    const dreamed = entries.filter((e) => e.startsWith("dreamed-"));
    expect(dreamed.length).toBe(1);

    // Verify diary entry appended.
    const diary = await readFile(join(resolveMemoryRoot(cwd), "dream-diary.md"), "utf8");
    expect(diary).toContain("# Dream Diary");
    expect(diary).toContain("- facts before: 3");
    expect(diary).toContain("- facts after: 2");
  });

  it("test_isoSlug_in_notes_file_name_strips_punctuation", async () => {
    await appendFactToMarkdown(cwd, { text: "one fact" });
    const embedding = stubEmbedding({ "one fact": [1, 0, 0] });

    const result = await runDreamingSweep({
      cwd,
      embedding,
      now: () => Date.UTC(2026, 5, 15, 8, 30, 45),
    });
    expect(result.status).toBe("ok");
    expect(result.notesWritten).toBe(1);

    const notesDir = join(resolveMemoryRoot(cwd), "notes");
    const entries = await readdir(notesDir);
    const dreamed = entries.find((e) => e.startsWith("dreamed-"));
    expect(dreamed).toBeDefined();
    // ISO 2026-06-15T08:30:45.000Z → after `replace(/[^\dT]/g, "-")` →
    // "2026-06-15T08-30-45-000-" with trailing dashes for the dropped Z.
    expect(dreamed).toMatch(/^dreamed-2026-06-15T08-30-45-/);
    expect(dreamed?.endsWith(".md")).toBe(true);
  });

  it("test_error_status_swallows_thrown_embedding_and_warns_to_stderr", async () => {
    await appendFactToMarkdown(cwd, { text: "trigger" });

    const failing: EmbeddingRuntime = {
      embed: async () => {
        throw new Error("upstream provider 503");
      },
      dimension: 3,
      providerId: "stub-fail",
      model: "stub-fail-model",
    } as unknown as EmbeddingRuntime;

    // The sweep reports through the SDK's diagnostics channel (one implementation), not stderr.
    const messages: string[] = [];
    setDiagnosticsSink((message) => messages.push(message));

    try {
      const result = await runDreamingSweep({ cwd, embedding: failing });
      expect(result.status).toBe("error");
      expect(result.factsBefore).toBe(0); // emptyResult shape on error
      expect(result.notesWritten).toBe(0);
      const msg = messages.join("");
      expect(msg).toContain("dreaming sweep failed");
      expect(msg).toContain("upstream provider 503");
    } finally {
      setDiagnosticsSink(undefined);
    }
  });

  it("test_concurrent_sweeps_serialize_via_per_cwd_mutex", async () => {
    // Single fact → 1 sweep produces 1 dream note. Two concurrent
    // sweeps under the same cwd must not interleave on the dream-note
    // write because of `withCwdMutex(\`dream:${cwd}\`)`. Both sweeps
    // will succeed; serialization is verified via the mutex preventing
    // partial / torn diary writes.
    await appendFactToMarkdown(cwd, { text: "serial fact" });
    const embedding = stubEmbedding({ "serial fact": [1, 0, 0] });

    const [a, b] = await Promise.all([
      runDreamingSweep({
        cwd,
        embedding,
        now: () => Date.UTC(2026, 0, 1, 12, 0, 0),
      }),
      runDreamingSweep({
        cwd,
        embedding,
        now: () => Date.UTC(2026, 0, 1, 12, 0, 1),
      }),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");

    const diary = await readFile(join(resolveMemoryRoot(cwd), "dream-diary.md"), "utf8");
    // 2 sweeps → 2 diary entries (both headers present).
    const headerMatches = diary.match(/^## 2026-01-01T12:00:0[01]/gm) ?? [];
    expect(headerMatches.length).toBe(2);
  });
});
