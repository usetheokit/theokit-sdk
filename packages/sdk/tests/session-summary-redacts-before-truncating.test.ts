import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRoot } from "../src/internal/memory/storage/memory-root.js";
import {
  sessionSummaryPath,
  writeSessionSummary,
} from "../src/internal/memory/storage/session-summary-writer.js";

describe("session summary writer", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("does not leak a secret prefix cut by the 2000-char truncation", async () => {
    dir = await mkdtemp(join(tmpdir(), "sess-sum-"));
    const root = dir as MemoryRoot;
    const secret = `sk-ant-${"A1b2C3d4".repeat(5)}`;
    // Place the secret so the 2000-char cut lands inside it, leaving a 10+ char tail-less prefix.
    const text = `${"x".repeat(1990)} ${secret} tail`;
    await writeSessionSummary({
      memoryRoot: root,
      runId: "run-1",
      agentId: "a",
      userText: text,
      assistantText: text,
      status: "finished",
      at: 0,
    });
    const out = await readFile(sessionSummaryPath(root, "run-1"), "utf8");
    expect(out).not.toContain("sk-ant-");
  });
});
