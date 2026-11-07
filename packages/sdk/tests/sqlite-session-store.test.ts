import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { SqliteSessionStore } from "../src/index.js";
import { SqliteSessionStore as FromPersistence } from "../src/persistence.js";

describe("B-596 — SqliteSessionStore", () => {
  it("is exported from the root and ./persistence", () => {
    expect(FromPersistence).toBe(SqliteSessionStore);
  });

  it("returns [] for an unknown agent and preserves append order across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "theokit-sqlite-store-"));
    const filePath = join(dir, "nested", "sessions.db");
    const a = new SqliteSessionStore({ filePath });
    expect(await a.readRecords("x")).toEqual([]);
    const recs = [{ n: 1 }, { n: 2 }, { n: 3 }] as never[];
    await a.appendRecords("x", recs.slice(0, 2));
    await a.appendRecords("y", [{ n: 9 }] as never[]);
    await a.appendRecords("x", recs.slice(2));
    await a.dispose();
    const b = new SqliteSessionStore({ filePath });
    expect(await b.readRecords("x")).toEqual(recs);
    expect(await b.readRecords("y")).toEqual([{ n: 9 }]);
    await b.dispose();
  });

  it("writes a session through an agent and resumes it from a fresh store", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "theokit-sqlite-cwd-"));
    const baseDir = await mkdtemp(join(tmpdir(), "theokit-sqlite-home-"));
    const filePath = join(baseDir, "sessions.db");
    const agent = await Agent.create({
      apiKey: "theo_test_sqlite_store",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, baseDir, sessionStore: new SqliteSessionStore({ filePath }) },
    });
    await Agent.injectSessionTurn(agent.agentId, { userText: "ping?", assistantText: "pong." });
    await agent.dispose?.();

    const resumed = await Agent.resume(agent.agentId, {
      apiKey: "theo_test_sqlite_store",
      local: { cwd, baseDir, sessionStore: new SqliteSessionStore({ filePath }) },
    });
    const messages = await Agent.transcript(resumed.agentId);
    expect(messages.map((m) => m.text)).toEqual(["ping?", "pong."]);
  });
});
