import { describe, expect, it } from "vitest";
import {
  Agent,
  InMemorySessionStore,
  type SessionRecord,
  type SessionStore,
} from "../src/index.js";
import { InMemorySessionStore as FromPersistence } from "../src/persistence.js";

const rec = (uuid: string, text: string): SessionRecord => ({
  type: "user",
  uuid,
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-07-15T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

describe("InMemorySessionStore", () => {
  it("is exported from the root and the persistence entry", () => {
    expect(FromPersistence).toBe(InMemorySessionStore);
  });

  it("appends, reads back, and isolates agents", async () => {
    const store = new InMemorySessionStore();
    expect(await store.readRecords("a")).toEqual([]);
    await store.appendRecords("a", [rec("1", "one")]);
    await store.appendRecords("a", [rec("2", "two")]);
    expect((await store.readRecords("a")).map((r) => r.uuid)).toEqual(["1", "2"]);
    expect(await store.readRecords("b")).toEqual([]);
  });

  it("does not expose its internal records to callers", async () => {
    const store = new InMemorySessionStore();
    await store.appendRecords("a", [rec("1", "one")]);
    (await store.readRecords("a")).pop();
    expect(await store.readRecords("a")).toHaveLength(1);
  });

  it("keeps records across dispose so the same instance can resume", async () => {
    const store = new InMemorySessionStore();
    await store.appendRecords("a", [rec("1", "one")]);
    await (store as SessionStore).dispose?.();
    expect(await store.readRecords("a")).toHaveLength(1);
  });

  it("shows the first turn in the store after two sends on one agent", async () => {
    const store = new InMemorySessionStore();
    const agent = await Agent.create({
      apiKey: "theo_test_inmem",
      model: { id: "claude-sonnet-4-6" },
      memory: { enabled: false },
      local: { sessionStore: store, registry: false },
    });
    await (await agent.send("first-turn-marker")).wait();
    await (await agent.send("second-turn-marker")).wait();
    await agent.dispose();
    const text = JSON.stringify(await store.readRecords(agent.agentId));
    expect(text).toContain("first-turn-marker");
    expect(text).toContain("second-turn-marker");
    expect(text.indexOf("first-turn-marker")).toBeLessThan(text.indexOf("second-turn-marker"));
  });
});
