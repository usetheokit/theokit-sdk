/**
 * SE41 T1 — the public `SessionStore` seam: exactly two methods over the NATIVE
 * `SessionRecord` shape (`readRecords` / `appendRecords`). This is the minimal
 * external-store contract that restores the serverless / multi-host resume use
 * case SE40 dropped with the `ConversationStorageAdapter` — WITHOUT reintroducing
 * that removed ~10-method adapter (no getMessages / getSessionMeta / delete /
 * objective). The type test asserts the exported surface AND that an in-memory
 * implementation satisfies it structurally.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { InMemorySessionStore, type SessionRecord, type SessionStore } from "../../../src/index.js";

describe("SessionStore public contract (SE41 T1)", () => {
  it("is exported from the public barrel with exactly readRecords + appendRecords over SessionRecord", () => {
    // A minimal, real in-memory implementation of the seam.
    const backing = new Map<string, SessionRecord[]>();
    const store: SessionStore = {
      async readRecords(agentId) {
        return backing.get(agentId) ?? [];
      },
      async appendRecords(agentId, records) {
        const prior = backing.get(agentId) ?? [];
        backing.set(agentId, [...prior, ...records]);
      },
    };

    expectTypeOf(store.readRecords).toEqualTypeOf<(agentId: string) => Promise<SessionRecord[]>>();
    expectTypeOf(store.appendRecords).toEqualTypeOf<
      (agentId: string, records: readonly SessionRecord[]) => Promise<void>
    >();
  });

  it("appendRecords then readRecords round-trips native records by agentId", async () => {
    const backing = new Map<string, SessionRecord[]>();
    const store: SessionStore = {
      async readRecords(agentId) {
        return backing.get(agentId) ?? [];
      },
      async appendRecords(agentId, records) {
        backing.set(agentId, [...(backing.get(agentId) ?? []), ...records]);
      },
    };

    const rec: SessionRecord = {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "s1",
      timestamp: "2026-07-15T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    };
    expect(await store.readRecords("agent-a")).toEqual([]);
    await store.appendRecords("agent-a", [rec]);
    expect(await store.readRecords("agent-a")).toEqual([rec]);
    // per-agent isolation — a different agentId sees nothing.
    expect(await store.readRecords("agent-b")).toEqual([]);
  });

  it("the built-in InMemorySessionStore satisfies the same contract", async () => {
    const store: SessionStore = new InMemorySessionStore();
    const rec: SessionRecord = {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "s1",
      timestamp: "2026-07-15T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    };
    expect(await store.readRecords("agent-a")).toEqual([]);
    await store.appendRecords("agent-a", [rec]);
    expect(await store.readRecords("agent-a")).toEqual([rec]);
    expect(await store.readRecords("agent-b")).toEqual([]);
  });
});
