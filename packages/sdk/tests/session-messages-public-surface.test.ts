import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import { FsSessionStore } from "../src/internal/persistence/fs-session-store.js";
import { transcriptPath } from "../src/internal/persistence/session-transcript.js";
import {
  persistTurn,
  type TranscriptLocation,
} from "../src/internal/session/agent-session-store.js";

/**
 * #546 — `readSessionMessages` was compiled into the package and absent from the type
 * surface, so a surface that repointed a session could not re-render what that session
 * already contained: the messages were on disk, the SDK read them to give the model its
 * context, and the screen stayed empty while the model demonstrably remembered.
 *
 * The internal function takes a `SessionStore`. Exporting it as-is would drag that
 * interface into the public surface; the issue asked instead for "a narrower equivalent:
 * given a session id and a cwd, return that session's messages", which is what these
 * tests pin.
 */
describe("#546 — a resumed session's messages are readable from the public surface", () => {
  let sessionDir: string;
  const cwd = "/tmp/theokit-546-proj";

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "theokit-546-"));
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  /** Write one real turn through the same path the SDK writes with. */
  async function seedSession(sessionId: string): Promise<void> {
    const store = new FsSessionStore({ baseDir: sessionDir, cwd });
    const loc: TranscriptLocation = { cwd, agentId: sessionId, model: "test-model" };
    await persistTurn(store, loc, sessionId, {
      userText: "what did we agree on?",
      conversation: [
        {
          type: "agentConversationTurn",
          turn: { steps: [{ type: "assistantMessage", message: { text: "ship the gate first" } }] },
        },
      ],
    });
  }

  it("exports readSessionMessages", () => {
    expect(
      (sdk as Record<string, unknown>).readSessionMessages,
      "@theokit/sdk must export readSessionMessages (#546)",
    ).toBeTypeOf("function");
  });

  it("returns the turn a session already contains, given its id and cwd", async () => {
    const sessionId = "agent-546-roundtrip";
    await seedSession(sessionId);

    const messages = await sdk.readSessionMessages({ sessionId, cwd, sessionDir });

    expect(messages.map((m) => ({ role: m.role, text: m.text }))).toEqual([
      { role: "user", text: "what did we agree on?" },
      { role: "assistant", text: "ship the gate first" },
    ]);
  });

  it("resolves an unwritten session to an empty history rather than throwing", async () => {
    // A fresh session has no transcript. The store's contract calls that `[]`, not a
    // failure, and a surface asking for a session the user just created must not crash.
    await expect(
      sdk.readSessionMessages({ sessionId: "agent-546-never-written", cwd, sessionDir }),
    ).resolves.toEqual([]);
  });

  it("does not require the caller to know the transcript layout", () => {
    // The point of the export: the encoded-project-dir layout and the record shape stay
    // private. If this ever needs a path, the narrow API failed its purpose.
    const arity = (sdk.readSessionMessages as (...a: unknown[]) => unknown).length;
    expect(arity, "readSessionMessages takes one options object").toBe(1);
  });
});

describe("#1494 — scope: 'all' reads the whole transcript", () => {
  let sessionDir: string;
  const cwd = "/tmp/theokit-1494-proj";
  const sessionId = "agent-1494";

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "theokit-1494-"));
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  const rec = (
    uuid: string | undefined,
    parentUuid: string | null,
    type: "user" | "assistant" | "system",
    content: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    type,
    ...(uuid === undefined ? {} : { uuid }),
    parentUuid,
    sessionId,
    timestamp: "2026-01-01T00:00:00Z",
    message: type === "system" ? undefined : { role: type, content },
    ...extra,
  });
  const text = (t: string) => [{ type: "text", text: t }];

  async function write(records: unknown[]): Promise<void> {
    const path = transcriptPath(sessionDir, cwd, sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  const texts = (m: { text: string }[]) => m.map((x) => x.text);

  it("returns both sides of a compaction boundary; the default only the active side", async () => {
    await write([
      rec("a", null, "user", text("before-q")),
      rec("b", "a", "assistant", text("before-a")),
      rec("c", null, "system", undefined, { subtype: "compact_boundary" }),
      rec("d", "c", "user", text("after-q")),
      rec("e", "d", "assistant", text("after-a")),
    ]);
    const opts = { sessionId, cwd, sessionDir };
    expect(texts(await sdk.readSessionMessages({ ...opts, scope: "all" }))).toEqual([
      "before-q",
      "before-a",
      "after-q",
      "after-a",
    ]);
    expect(texts(await sdk.readSessionMessages(opts))).toEqual(["after-q", "after-a"]);
  });

  it("returns the messages of both branches", async () => {
    await write([
      rec("a", null, "user", text("root")),
      rec("b", "a", "assistant", text("branch-1")),
      rec("c", "a", "assistant", text("branch-2")),
    ]);
    const opts = { sessionId, cwd, sessionDir };
    expect(texts(await sdk.readSessionMessages({ ...opts, scope: "all" }))).toEqual([
      "root",
      "branch-1",
      "branch-2",
    ]);
    expect(texts(await sdk.readSessionMessages(opts))).toEqual(["root", "branch-2"]);
  });

  it("tolerates records without a uuid and string or irregular content", async () => {
    await write([
      rec(undefined, null, "user", "plain string"),
      rec("a", null, "assistant", ["junk", null, { type: "text", text: "ok" }]),
      rec("b", "a", "assistant", { not: "an array" }),
    ]);
    const all = await sdk.readSessionHistory({ sessionId, cwd, sessionDir, scope: "all" });
    expect(all.state).toBe("present");
    expect(all.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "plain string"],
      ["assistant", "ok"],
      ["assistant", ""],
    ]);
  });
});
