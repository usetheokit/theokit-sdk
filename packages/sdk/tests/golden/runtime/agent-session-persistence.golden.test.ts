import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../../src/index.js";
import { FsSessionStore } from "../../../src/internal/persistence/fs-session-store.js";
import {
  readTranscript,
  type SessionRecord,
  transcriptPath,
} from "../../../src/internal/persistence/session-transcript.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../../src/internal/runtime/registry/agent-registry.js";
import {
  clearAllSessions,
  flushSessionWrites,
  getSessionMessages,
  hydrateSession,
} from "../../../src/internal/session/agent-session.js";
import {
  appendCompactBoundaryRecord,
  persistTurn,
  readSessionMessages,
  type TranscriptLocation,
} from "../../../src/internal/session/agent-session-store.js";

/**
 * SE40 (v4.0) — session persistence IS the native Claude-shaped `.jsonl` transcript
 * at `<baseDir>/projects/<encoded-cwd>/<agentId>.jsonl`. These golden tests assert
 * the native record/DAG shape, append-only compaction (`compact_boundary`), and
 * resume-after-restart reconstruction.
 *
 * Tests use isolated tmpdirs so disk writes never collide across cases.
 */
describe("Agent session persistence (SE40 native transcript)", () => {
  let baseDir: string;
  const cwd = "/tmp/theokit-proj";

  function loc(agentId: string): TranscriptLocation {
    return { cwd, agentId, model: "test-model" };
  }
  const store = () => new FsSessionStore({ baseDir, cwd });

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "theokit-session-"));
    clearAllSessions();
    clearAgentRegistry();
  });

  afterEach(async () => {
    await flushSessionWrites();
    clearAllSessions();
    clearAgentRegistry();
    invalidateRegistryHydration();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("persistTurn stamps loc.memoryPartition on the records it writes", async () => {
    const agentId = "agent-test-partition";
    await persistTurn(store(), { ...loc(agentId), memoryPartition: "u-1" }, agentId, {
      userText: "partitioned",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "ok" } }] },
        },
      ],
    });
    const records = await store().readRecords(agentId);
    expect(records.length).toBe(2);
    expect(records.every((r) => r.memoryPartition === "u-1")).toBe(true);
  });

  it("append-then-read-after-restart — persistTurn writes native records; readSessionMessages reconstructs the turn", async () => {
    const agentId = "agent-test-append-read";
    await persistTurn(store(), loc(agentId), agentId, {
      userText: "hello world",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "hi back" } }] },
        },
      ],
    });

    const fromDisk = await readSessionMessages(store(), agentId);
    // theokit#146 added `parts` alongside `text`, so this asserts the two fields it is about
    // rather than the whole object — a strict `toEqual` here would fail on any additive field and
    // says nothing extra about round-tripping.
    expect(fromDisk.map((m) => ({ role: m.role, text: m.text }))).toEqual([
      { role: "user", text: "hello world" },
      { role: "assistant", text: "hi back" },
    ]);
    expect(fromDisk.map((m) => m.parts)).toEqual([
      [{ type: "text", text: "hello world" }],
      [{ type: "text", text: "hi back" }],
    ]);
  });

  it("native-record-shape — the on-disk `.jsonl` carries uuid/parentUuid DAG + message.content blocks", async () => {
    const agentId = "agent-shape";
    await persistTurn(store(), loc(agentId), agentId, {
      userText: "question",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "answer" } }] },
        },
      ],
    });
    const records = await readTranscript(transcriptPath(baseDir, cwd, agentId));
    expect(records.length).toBe(2);
    expect(records[0]?.type).toBe("user");
    expect(records[0]?.parentUuid).toBeNull();
    expect(records[1]?.type).toBe("assistant");
    // parent chain: assistant parents on user.
    expect(records[1]?.parentUuid).toBe(records[0]?.uuid);
    const userContent = records[0]?.message?.content as Array<{ type: string; text: string }>;
    expect(userContent[0]).toEqual({ type: "text", text: "question" });
  });

  it("tool-turn — tool_use + paired tool_result blocks survive the round trip (fold on read)", async () => {
    const agentId = "agent-tool";
    await persistTurn(store(), loc(agentId), agentId, {
      userText: "run a tool",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: {
            steps: [
              {
                type: "toolCall",
                message: { callId: "call-1", name: "read", args: { path: "x" } },
              },
              {
                type: "toolResult",
                message: { callId: "call-1", name: "read", result: "file body", isError: false },
              },
              { type: "assistantMessage", message: { text: "done" } },
            ],
          },
        },
      ],
    });
    const records = await readTranscript(transcriptPath(baseDir, cwd, agentId));
    // user + assistant(tool_use) + user(tool_result) — assistant appended before tool results.
    const assistant = records.find((r) => r.type === "assistant");
    const blocks = assistant?.message?.content as Array<{
      type: string;
      id?: string;
      tool_use_id?: string;
    }>;
    expect(blocks.some((b) => b.type === "tool_use" && b.id === "call-1")).toBe(true);
    const toolResultRec = records.find(
      (r) =>
        r.type === "user" &&
        Array.isArray(r.message?.content) &&
        (r.message?.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
    );
    expect(toolResultRec).toBeDefined();
    // Reconstructed session folds tool turns into assistant-role context.
    const reconstructed = await readSessionMessages(store(), agentId);
    expect(reconstructed.some((m) => m.text.includes("[tool call] read"))).toBe(true);
    expect(reconstructed.some((m) => m.text.includes("[tool result]"))).toBe(true);
  });

  it("append-only compaction — appendCompactBoundaryRecord adds a compact_boundary root, never shrinking the file", async () => {
    const agentId = "agent-compaction";
    for (let i = 0; i < 5; i += 1) {
      await persistTurn(store(), loc(agentId), agentId, {
        userText: `turn ${i}`,
        conversation: [],
      });
    }
    const before = await readTranscript(transcriptPath(baseDir, cwd, agentId));
    await appendCompactBoundaryRecord(store(), loc(agentId), agentId, {
      preTokens: 1234,
      trigger: "auto",
    });
    const after = await readTranscript(transcriptPath(baseDir, cwd, agentId));
    // Never shrinks: all prior records remain + one new boundary.
    expect(after.length).toBe(before.length + 1);
    const boundary = after[after.length - 1] as SessionRecord;
    expect(boundary.type).toBe("system");
    expect(boundary.subtype).toBe("compact_boundary");
    expect(boundary.parentUuid).toBeNull();
    expect(boundary.compactMetadata).toEqual({ preTokens: 1234, trigger: "auto" });
  });

  it("resume-after-compaction — reconstruction replays only the post-boundary continuation", async () => {
    const agentId = "agent-resume-after-compact";
    await persistTurn(store(), loc(agentId), agentId, {
      userText: "before boundary",
      conversation: [],
    });
    await appendCompactBoundaryRecord(store(), loc(agentId), agentId, {
      preTokens: 0,
      trigger: "auto",
    });
    await persistTurn(store(), loc(agentId), agentId, {
      userText: "after boundary",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "post" } }] },
        },
      ],
    });
    const reconstructed = await readSessionMessages(store(), agentId);
    // The compact_boundary is a new root — the walk terminates there, so only the
    // post-boundary continuation is replayed.
    expect(reconstructed.map((m) => m.text)).toContain("after boundary");
    expect(reconstructed.map((m) => m.text)).not.toContain("before boundary");
  });

  it("malformed-last-line-skipped — a torn final line (crash mid-write) is skipped; the DAG still reconstructs", async () => {
    const agentId = "agent-malformed";
    await persistTurn(store(), loc(agentId), agentId, {
      userText: "complete",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "ok" } }] },
        },
      ],
    });
    const path = transcriptPath(baseDir, cwd, agentId);
    const raw = await readFile(path, "utf8");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path, `${raw}{"type":"user","uuid":"torn`, "utf8"),
    );
    const reconstructed = await readSessionMessages(store(), agentId);
    expect(reconstructed.some((m) => m.text === "complete")).toBe(true);
  });

  it("per-agent-isolation — two agentIds → two files; neither sees the other", async () => {
    await persistTurn(store(), loc("agent-iso-a"), "agent-iso-a", {
      userText: "only A",
      conversation: [],
    });
    await persistTurn(store(), loc("agent-iso-b"), "agent-iso-b", {
      userText: "only B",
      conversation: [],
    });
    const a = await readSessionMessages(store(), "agent-iso-a");
    const b = await readSessionMessages(store(), "agent-iso-b");
    expect(a.map((m) => m.text)).toEqual(["only A"]);
    expect(b.map((m) => m.text)).toEqual(["only B"]);
  });

  it("persists-text-with-newlines — embedded \\n, \\t, and quotes round-trip; one JSONL line per record", async () => {
    const agentId = "agent-newlines";
    const tricky = 'line1\nline2\twith\ttabs\nand "quoted" stuff';
    await persistTurn(store(), loc(agentId), agentId, { userText: tricky, conversation: [] });
    const reconstructed = await readSessionMessages(store(), agentId);
    expect(reconstructed[0]?.text).toBe(tricky);
    const raw = await readFile(transcriptPath(baseDir, cwd, agentId), "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0).length).toBe(1);
  });

  it("hydrateSession — populates the in-memory cache for getSessionMessages", async () => {
    const agentId = "agent-hydrate";
    await persistTurn(store(), loc(agentId), agentId, {
      userText: "seeded user",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "seeded assistant" } }] },
        },
      ],
    });
    expect(getSessionMessages(agentId)).toEqual([]);
    await hydrateSession(agentId, { store: store(), cwd });
    expect(getSessionMessages(agentId).map((m) => m.text)).toEqual([
      "seeded user",
      "seeded assistant",
    ]);
  });

  it("session-survives-after-create-and-resume — Agent.create → send → resume → getSessionMessages sees the user turn", async () => {
    const agentId = "agent-survives-restart";
    // Use the per-test tmpdir (baseDir) as the cwd too, so the persisted
    // registry.json is isolated per test run — no cross-run id collision.
    const testCwd = baseDir;
    const original = await Agent.create({
      agentId,
      apiKey: "theo_test_session_survives",
      model: { id: "google/gemini-2.0-flash-001" },
      local: { cwd: testCwd, baseDir },
    });
    const run = await original.send("first message that must survive restart");
    await run.wait();
    await original.dispose();

    clearAllSessions();
    clearAgentRegistry();
    invalidateRegistryHydration();

    const resumed = await Agent.resume(agentId, { local: { cwd: testCwd, baseDir } });
    const messages = getSessionMessages(resumed.agentId);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.text).toContain("first message that must survive restart");
    await resumed.dispose();
  });
});
