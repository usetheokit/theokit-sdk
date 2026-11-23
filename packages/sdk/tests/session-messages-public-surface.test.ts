import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import { FsSessionStore } from "../src/internal/persistence/fs-session-store.js";
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
