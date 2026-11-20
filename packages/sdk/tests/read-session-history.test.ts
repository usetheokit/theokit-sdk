import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSessionHistory, readSessionMessages } from "../src/index.js";
import { FsSessionStore } from "../src/internal/persistence/fs-session-store.js";
import { transcriptPath } from "../src/internal/persistence/session-transcript.js";
import {
  persistTurn,
  type TranscriptLocation,
} from "../src/internal/session/agent-session-store.js";

describe("readSessionHistory (#1078)", () => {
  let sessionDir: string;
  const cwd = "/tmp/theokit-1078-proj";
  const sessionId = "agent-1078";
  const path = () => transcriptPath(sessionDir, cwd, sessionId);
  const opts = () => ({ sessionId, cwd, sessionDir });

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "theokit-1078-"));
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    const store = new FsSessionStore({ baseDir: sessionDir, cwd });
    const loc: TranscriptLocation = { cwd, agentId: sessionId, model: "test-model" };
    await persistTurn(store, loc, sessionId, {
      userText: "hello",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "hi there" } }] },
        },
      ],
    });
  }

  it("is absent for a session with no transcript", async () => {
    expect(await readSessionHistory(opts())).toEqual({
      state: "absent",
      messages: [],
      skippedLines: 0,
    });
  });

  it("is present with the same messages readSessionMessages returns", async () => {
    await seed();
    const h = await readSessionHistory(opts());
    expect(h.state).toBe("present");
    expect(h.skippedLines).toBe(0);
    expect(h.messages.length).toBeGreaterThan(0);
    expect(h.messages).toEqual(await readSessionMessages(opts()));
  });

  it("counts a torn last line as one skipped line", async () => {
    await seed();
    await appendFile(path(), '{"uuid":"x","type":"us');
    const h = await readSessionHistory(opts());
    expect(h.state).toBe("present");
    expect(h.skippedLines).toBe(1);
    expect(h.messages).toEqual(await readSessionMessages(opts()));
  });

  it("is unreadable, without the file's text, when no line is a record", async () => {
    await mkdir(join(path(), ".."), { recursive: true });
    await writeFile(path(), "not json\nnot json\n");
    const h = await readSessionHistory(opts());
    expect(h.state).toBe("unreadable");
    expect(h.messages).toEqual([]);
    expect(h.skippedLines).toBe(2);
    expect(h.reason).toBeTypeOf("string");
    expect(h.reason).not.toContain("not json");
    expect(await readFile(path(), "utf8")).toContain("not json");
  });

  it("is unreadable, not thrown, when the transcript path is a directory", async () => {
    await mkdir(path(), { recursive: true });
    const h = await readSessionHistory(opts());
    expect(h.state).toBe("unreadable");
    expect(h.reason).toBeTypeOf("string");
  });

  it("treats an empty transcript file as present", async () => {
    await mkdir(join(path(), ".."), { recursive: true });
    await writeFile(path(), "");
    expect(await readSessionHistory(opts())).toEqual({
      state: "present",
      messages: [],
      skippedLines: 0,
    });
  });
});
