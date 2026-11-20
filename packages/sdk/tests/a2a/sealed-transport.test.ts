import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
  type A2AMessage,
  type A2ATransport,
  A2AUntrustedPeerError,
  generateA2AIdentity,
  inMemoryTransport,
  jsonSequenceStore,
  MessageBus,
  memorySequenceStore,
  sealedTransport,
} from "../../src/a2a/index.js";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

const alice = generateA2AIdentity();
const bob = generateA2AIdentity();
const mallory = generateA2AIdentity();

afterEach(() => setDiagnosticsSink(undefined));

function capture(): string[] {
  const lines: string[] = [];
  setDiagnosticsSink((m) => lines.push(m));
  return lines;
}

/** An inner transport that records everything sent through it. */
function recording(): { inner: A2ATransport; sent: A2AMessage[] } {
  const base = inMemoryTransport();
  const sent: A2AMessage[] = [];
  return {
    sent,
    inner: {
      send: async (m) => {
        sent.push(structuredClone(m));
        await base.send(m);
      },
      poll: (id) => base.poll(id),
    },
  };
}

function pair(inner: A2ATransport) {
  const a = sealedTransport(inner, {
    identity: alice,
    trustedPeers: new Map([["bob", bob.publicKey]]),
  });
  const b = sealedTransport(inner, {
    identity: bob,
    trustedPeers: new Map([["alice-name", alice.publicKey]]),
  });
  return { a, b };
}

function msg(to = "bob"): A2AMessage {
  return { type: "note", payload: { secret: "hunter2" }, from: "alice", to, timestamp: 5 };
}

describe("sealedTransport", () => {
  it("delivers to the peer with from set to the trusted name, hiding plaintext", async () => {
    const { inner, sent } = recording();
    const { a, b } = pair(inner);
    const received: A2AMessage[] = [];
    const bus = new MessageBus({ transport: b });
    bus.register("me", (m) => void received.push(m));
    await a.send(msg());
    expect(JSON.stringify(sent)).not.toContain("hunter2");
    expect(JSON.stringify(sent)).not.toContain("alice-name");
    expect(await bus.pump()).toBe(1);
    expect(received[0]).toMatchObject({
      type: "note",
      payload: { secret: "hunter2" },
      from: "alice-name",
      to: "me",
      origin: { kind: "peer", from: "alice-name" },
    });
  });

  async function tamper(mutate: (p: Record<string, unknown>) => void): Promise<string[]> {
    const { inner, sent } = recording();
    const { a, b } = pair(inner);
    await a.send(msg());
    const first = sent[0] as A2AMessage;
    const payload = structuredClone(first.payload) as Record<string, unknown>;
    mutate(payload);
    const lines = capture();
    const tampered = inMemoryTransport();
    await tampered.send({ ...first, payload });
    const bTampered = sealedTransport(tampered, {
      identity: bob,
      trustedPeers: new Map([["alice-name", alice.publicKey]]),
    });
    expect(await bTampered.poll("me")).toEqual([]);
    void b;
    return lines;
  }

  function flip(value: unknown): string {
    const buf = Buffer.from(String(value), "base64url");
    buf[0] = (buf[0] as number) ^ 1;
    return buf.toString("base64url");
  }

  it.each(["ct", "nonce", "eph"])("drops a message with a flipped %s", async (field) => {
    const lines = await tamper((p) => {
      p[field] = flip(p[field]);
    });
    expect(lines.join("")).toMatch(/dropped \((authentication_failed|malformed)\)/);
    expect(lines.join("")).not.toContain("hunter2");
  });

  it("drops a message with a changed seq", async () => {
    const lines = await tamper((p) => {
      p.seq = (p.seq as number) + 1;
    });
    expect(lines.join("")).toContain("authentication_failed");
  });

  it("accepts a replayed envelope once", async () => {
    const { inner, sent } = recording();
    const { a, b } = pair(inner);
    await a.send(msg());
    const copy = structuredClone(sent[0] as A2AMessage);
    expect(await b.poll("me")).toHaveLength(1);
    const lines = capture();
    await inner.send(copy);
    expect(await b.poll("me")).toEqual([]);
    expect(lines.join("")).toContain("(replay)");
  });

  it("drops a message sealed by an untrusted key", async () => {
    const inner = inMemoryTransport();
    const m = sealedTransport(inner, {
      identity: mallory,
      trustedPeers: new Map([["bob", bob.publicKey]]),
    });
    const { b } = pair(inner);
    await m.send(msg());
    const lines = capture();
    expect(await b.poll("me")).toEqual([]);
    expect(lines.join("")).toContain("(untrusted_peer)");
  });

  it("drops malformed messages without blocking later ones", async () => {
    const inner = inMemoryTransport();
    const { a, b } = pair(inner);
    await inner.send({ type: "x", payload: 1, from: "?", to: bob.publicKey, timestamp: 1 });
    await a.send(msg());
    const lines = capture();
    expect(await b.poll("me")).toHaveLength(1);
    expect(lines.join("")).toContain("(malformed)");
  });

  it("rejects send to an unknown peer with A2AUntrustedPeerError", async () => {
    const { a } = pair(inMemoryTransport());
    const err = await a.send(msg("eve")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(A2AUntrustedPeerError);
    expect((err as A2AUntrustedPeerError).message).toContain("eve");
    expect((err as A2AUntrustedPeerError).peer).toBe("eve");
  });
});

describe("sequence stores", () => {
  it("memory store numbers sends and rejects non-increasing receives", async () => {
    const s = memorySequenceStore();
    expect(await Promise.all([s.nextSent("k"), s.nextSent("k")])).toEqual([1, 2]);
    expect(await s.acceptReceived("k", 3)).toBe(true);
    expect(await s.acceptReceived("k", 3)).toBe(false);
    expect(await s.acceptReceived("k", 2)).toBe(false);
  });

  it("json store keeps counters across instances with mode 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seq-"));
    onTestFinished(() => removeTempDirRobustSync(dir));
    const file = join(dir, "seq.json");
    const one = jsonSequenceStore(file);
    await one.nextSent("k");
    await one.acceptReceived("k", 4);
    const two = jsonSequenceStore(file);
    expect(await two.nextSent("k")).toBe(2);
    expect(await two.acceptReceived("k", 4)).toBe(false);
    expect(await two.acceptReceived("k", 5)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
