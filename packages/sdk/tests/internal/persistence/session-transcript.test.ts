/**
 * SE40 — native Claude-shaped session transcript. Unit tests for the PURE core: record builders
 * (append-per-turn, parentUuid chain, redaction) + the DAG reader `reconstructMessages` (leaf
 * detection, parentUuid walk, dedup earliest-session, tool_use/tool_result re-pairing, compact_boundary
 * as a walk-terminating root). Mirrors the claude-code-log dag.py contract (see the SE40 blueprint).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  encodeProjectDir,
  expandTilde,
  readTranscript,
  reconstructMessages,
  type SessionRecord,
  SessionTranscript,
  transcriptPath,
  writeTranscript,
} from "../../../src/internal/persistence/session-transcript.js";

const BASE = { cwd: "/home/u/proj", sessionId: "s1", model: "openai/gpt-4o-mini" };

describe("SE40 — session transcript builders (SessionTranscript)", () => {
  it("stamps the memory partition on conversation records only when one is set", () => {
    const t = new SessionTranscript({ ...BASE, memoryPartition: "u-1" });
    expect(t.appendUserTurn("hi").memoryPartition).toBe("u-1");
    expect(t.appendAssistantTurn({ text: "yo" }).memoryPartition).toBe("u-1");
    expect(t.appendCompactBoundary({ preTokens: 1, trigger: "auto" }).memoryPartition).toBe(
      undefined,
    );
    expect(new SessionTranscript(BASE).appendUserTurn("hi").memoryPartition).toBeUndefined();
  });

  it("appends a chained user→assistant(text+tool_use)→user(tool_result) transcript with a valid DAG", () => {
    const t = new SessionTranscript(BASE);
    const r0 = t.appendUserTurn("compute 17*23");
    const r1 = t.appendAssistantTurn({
      text: "using the tool",
      toolCalls: [{ id: "tu_A", name: "calc", input: { a: 17, b: 23 } }],
    });
    const r2 = t.appendToolResults([{ toolUseId: "tu_A", content: "391", isError: false }]);

    // envelope + roles
    expect(r0.type).toBe("user");
    expect(r0.parentUuid).toBeNull();
    expect(r1.type).toBe("assistant");
    expect(r1.parentUuid).toBe(r0.uuid);
    expect(r2.parentUuid).toBe(r1.uuid);
    // assistant carries message.{id,model,role} + structured blocks
    const m1 = r1.message as {
      id?: string;
      model?: string;
      content: Array<Record<string, unknown>>;
    };
    expect(m1.id).toBeTruthy();
    expect(m1.model).toBe(BASE.model);
    expect(m1.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(m1.content.find((b) => b.type === "tool_use")).toMatchObject({
      id: "tu_A",
      name: "calc",
    });
    // tool_result pairs by id
    const tr = (r2.message?.content as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_result",
    );
    expect(tr).toMatchObject({ tool_use_id: "tu_A", content: "391" });
  });

  it("redacts secrets in text, tool args, and tool results", () => {
    const t = new SessionTranscript(BASE);
    t.appendAssistantTurn({
      text: "tok sk-abcdefghijklmnopqrstuvwx1234567890",
      toolCalls: [{ id: "t1", name: "api", input: { key: "sk-argsecretabcdefghij1234567890" } }],
    });
    t.appendToolResults([
      { toolUseId: "t1", content: "sk-ressecretabcdefghij1234567890", isError: false },
    ]);
    const dump = JSON.stringify(t.records());
    expect(dump).not.toContain("sk-abcdefghijklmnopqrstuvwx1234567890");
    expect(dump).not.toContain("sk-argsecretabcdefghij1234567890");
    expect(dump).not.toContain("sk-ressecretabcdefghij1234567890");
  });

  it("encodeProjectDir matches the Claude Code path convention", () => {
    expect(encodeProjectDir("/home/u/proj")).toBe("-home-u-proj");
  });
});

describe("SE40 — reconstructMessages (DAG reader → LlmMessage[])", () => {
  it("rebuilds the message history with re-paired tool_use/tool_result (walk leaf→root)", () => {
    const t = new SessionTranscript(BASE);
    t.appendUserTurn("compute 17*23");
    t.appendAssistantTurn({
      text: "ok",
      toolCalls: [{ id: "tu_A", name: "calc", input: { a: 17 } }],
    });
    t.appendToolResults([{ toolUseId: "tu_A", content: "391", isError: false }]);
    t.appendAssistantTurn({ text: "the answer is 391" });

    const msgs = reconstructMessages(t.records());
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // the tool_use in the assistant turn + the tool_result in the user turn keep matching ids
    const toolUse = msgs[1]!.content.find((p) => p.type === "tool_use") as
      | { id: string }
      | undefined;
    const toolResult = msgs[2]!.content.find((p) => p.type === "tool_result") as
      | { toolUseId: string }
      | undefined;
    expect(toolUse?.id).toBe("tu_A");
    expect(toolResult?.toolUseId).toBe("tu_A");
  });

  it("stops the walk at a compact_boundary root (resume replays only post-compaction)", () => {
    // pre-compaction: user0 → assistant0
    const t = new SessionTranscript(BASE);
    t.appendUserTurn("old question");
    t.appendAssistantTurn({ text: "old answer" });
    // compaction: a compact_boundary NEW ROOT + a continuation user turn parented on it
    t.appendCompactBoundary({ preTokens: 1234, trigger: "auto" });
    t.appendUserTurn("This session is being continued from a previous conversation. new question");
    t.appendAssistantTurn({ text: "new answer" });

    const msgs = reconstructMessages(t.records());
    // only the post-boundary continuation is replayed (2 msgs), NOT the pre-compaction pair
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const firstText = (msgs[0]!.content[0] as { text: string }).text;
    expect(firstText).toContain("new question");
  });

  it("dedups a uuid appearing in two sessions, keeping the earliest-session record", () => {
    const shared: SessionRecord = {
      type: "assistant",
      uuid: "dup",
      parentUuid: null,
      sessionId: "early",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        id: "m",
        model: "x",
        role: "assistant",
        content: [{ type: "text", text: "EARLY" }],
      },
    };
    const later: SessionRecord = {
      ...shared,
      sessionId: "late",
      timestamp: "2026-02-01T00:00:00.000Z",
      message: {
        id: "m",
        model: "x",
        role: "assistant",
        content: [{ type: "text", text: "LATE" }],
      },
    };
    // later file lists both sessions; earliest session (by first timestamp) wins for the dup uuid
    const msgs = reconstructMessages([later, shared]);
    const text = (msgs.at(-1)!.content[0] as { text: string }).text;
    expect(text).toBe("EARLY");
  });
});

describe("SE40 — transcript file I/O (Claude layout)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "se40-io-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("expandTilde resolves a leading ~/ to an absolute home path (Claude CLI interop baseDir)", () => {
    // the load-bearing interop case: `baseDir: "~/.claude"` MUST become <home>/.claude, not ./~/.claude
    expect(expandTilde("~/.claude")).toBe(join(homedir(), ".claude"));
    expect(expandTilde("~")).toBe(homedir());
    // no leading tilde → untouched (absolute stays absolute; a bare "~name" is NOT expanded)
    expect(expandTilde("/abs/base")).toBe("/abs/base");
    expect(expandTilde("./rel")).toBe("./rel");
    expect(expandTilde("~theo/x")).toBe("~theo/x");
  });

  it("transcriptPath uses <baseDir>/projects/<encoded-cwd>/<session-uuid>.jsonl (traversal-safe)", () => {
    const p = transcriptPath("/base", "/home/u/proj", "../evil");
    // #400 — the filename is a UUID derived from the id, so a hostile id is not sanitized into
    // something harmless, it stops being representable in the name at all. This used to assert the
    // exact sanitized output `---evil.jsonl`, which was how the property was achieved rather than
    // the property itself.
    expect(p).toMatch(
      /^\/base\/projects\/-home-u-proj\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/,
    );
    expect(p).not.toContain("..");
  });

  it("write → read → reconstruct round-trips a tool-calling session from disk", async () => {
    const t = new SessionTranscript({ cwd: "/home/u/proj", sessionId: "s1", model: "m" });
    t.appendUserTurn("compute 17*23");
    t.appendAssistantTurn({
      text: "ok",
      toolCalls: [{ id: "tu_A", name: "calc", input: { a: 17 } }],
    });
    t.appendToolResults([{ toolUseId: "tu_A", content: "391", isError: false }]);
    t.appendAssistantTurn({ text: "391" });

    const path = transcriptPath(dir, "/home/u/proj", "s1");
    await writeTranscript(path, t.records());
    const back = await readTranscript(path);
    expect(back).toHaveLength(t.records().length);

    const msgs = reconstructMessages(back);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const toolResult = msgs[2]!.content.find((p) => p.type === "tool_result") as {
      toolUseId: string;
    };
    expect(toolResult.toolUseId).toBe("tu_A");
  });

  it("readTranscript returns [] for a missing file and skips a torn last line", async () => {
    expect(await readTranscript(join(dir, "nope.jsonl"))).toEqual([]);
    const path = join(dir, "torn.jsonl");
    const good = JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "s",
      timestamp: "t",
      message: { role: "user", content: [] },
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, `${good}\n{"type":"user","uuid":"broke`); // torn last line
    const recs = await readTranscript(path);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.uuid).toBe("u1");
  });
});

describe("M50 — compact boundary with replacement (end of the amnesia)", () => {
  it("boundary_with_replacement_replays_summary_after_resume", () => {
    const t = new SessionTranscript(BASE);
    t.appendUserTurn("old question 1");
    t.appendAssistantTurn({ text: "old answer 1" });
    t.appendUserTurn("old question 2");
    t.appendAssistantTurn({ text: "old answer 2" });
    // compact: boundary (new root) + replacement chained onto it (recent user + handoff summary)
    t.appendCompactBoundary({ preTokens: 1000, trigger: "manual" });
    t.appendUserTurn("old question 2"); // recent user message preserved verbatim
    t.appendUserTurn("[COMPACT SUMMARY]\nprogress: X decided; Y outstanding");
    // post-compact continuation
    t.appendUserTurn("new question");
    t.appendAssistantTurn({ text: "new answer" });

    const msgs = reconstructMessages(t.records());
    const texts = msgs.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    expect(texts.join("\n")).toContain("[COMPACT SUMMARY]");
    expect(texts.join("\n")).toContain("new question");
    expect(texts.join("\n")).not.toContain("old answer 1"); // pre-boundary does not replay
    // the replacement comes BEFORE the continuation
    const iSummary = texts.findIndex((x) => x.includes("[COMPACT SUMMARY]"));
    const iNew = texts.findIndex((x) => x.includes("new question"));
    expect(iSummary).toBeGreaterThanOrEqual(0);
    expect(iSummary).toBeLessThan(iNew);
  });

  it("legacy_boundary_without_replacement_still_terminates_walk", () => {
    const t = new SessionTranscript(BASE);
    t.appendUserTurn("before");
    t.appendCompactBoundary({ preTokens: 0, trigger: "auto" });
    t.appendUserTurn("after");
    const msgs = reconstructMessages(t.records());
    const joined = msgs.map((m) => JSON.stringify(m.content)).join("\n");
    expect(joined).toContain("after");
    expect(joined).not.toContain("before");
  });
});
