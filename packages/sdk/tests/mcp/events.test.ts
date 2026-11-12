/**
 * #975 — a real local MCP server implementing the events profile (HTTP, no fake transport) emits
 * an event; the SDK subscriber receives it with its subscription id; a wrong signature is rejected.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpEventSubscriber,
  MCP_EVENT_SIGNATURE_HEADER,
  type McpEventDelivery,
  signMcpEvent,
  verifyMcpEventSignature,
} from "../../src/mcp-events.js";

interface Sub {
  id: string;
  callbackUrl: string;
  secret: string;
}

interface ServerBehavior {
  /** Methods the server received, in order. */
  methods?: string[];
  /** Respond with a JSON-RPC error for this method. */
  errorOn?: string;
  /** Result returned for events/subscribe instead of a subscription id. */
  subscribeResult?: unknown;
}

async function startServer(
  subs: Sub[],
  behavior: ServerBehavior = {},
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const msg = JSON.parse(raw) as { id: number; method: string; params: Record<string, string> };
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      behavior.methods?.push(msg.method);
      if (msg.method === behavior.errorOn) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "nope" } }));
        return;
      }
      if (msg.method === "events/subscribe") {
        const sub = {
          id: `sub-${subs.length + 1}`,
          callbackUrl: msg.params.callbackUrl as string,
          secret: msg.params.secret as string,
        };
        subs.push(sub);
        reply(behavior.subscribeResult ?? { subscriptionId: sub.id });
      } else reply({});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

function deliver(sub: Sub, body: string, signature: string): Promise<number> {
  return fetch(sub.callbackUrl, {
    method: "POST",
    headers: { [MCP_EVENT_SIGNATURE_HEADER]: signature },
    body,
  }).then((r) => r.status);
}

describe("mcp events subscription", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it("delivers a signed event with its subscription id and rejects a wrong signature", async () => {
    const subs: Sub[] = [];
    const { server, url } = await startServer(subs);
    const subscriber = createMcpEventSubscriber({ server: { type: "http", url } });
    cleanup.push(
      () => subscriber.close(),
      () => new Promise<void>((r) => server.close(() => r())),
    );
    const got: McpEventDelivery[] = [];
    const sub = await subscriber.subscribe({ events: ["x"], onEvent: (d) => void got.push(d) });
    expect(sub.subscriptionId).toBe("sub-1");

    const body = JSON.stringify({ subscriptionId: "sub-1", type: "x", data: { n: 42 } });
    const s = subs[0] as Sub;
    expect(await deliver(s, body, signMcpEvent("wrong-secret", body))).toBe(401);
    expect(await deliver(s, body, "")).toBe(401);
    expect(got).toHaveLength(0);

    expect(await deliver(s, body, signMcpEvent(s.secret, body))).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([{ subscriptionId: "sub-1", event: JSON.parse(body) }]);
  });

  it.each([
    ["https://hooks.example.com", "https://hooks.example.com"],
    ["https://hooks.example.com/", "https://hooks.example.com"],
    [`https://hooks.example.com${"/".repeat(50_000)}`, "https://hooks.example.com"],
  ])("trims trailing slashes from callbackOrigin %#", async (callbackOrigin, expected) => {
    const subs: Sub[] = [];
    const { server, url } = await startServer(subs);
    const subscriber = createMcpEventSubscriber({ server: { type: "http", url }, callbackOrigin });
    cleanup.push(
      () => subscriber.close(),
      () => new Promise<void>((r) => server.close(() => r())),
    );
    await subscriber.subscribe({ onEvent: () => {} });
    expect((subs[0] as Sub).callbackUrl.startsWith(`${expected}/mcp-events/`)).toBe(true);
  });

  async function setup(behavior: ServerBehavior = {}, port?: number) {
    const subs: Sub[] = [];
    const { server, url } = await startServer(subs, behavior);
    const subscriber = createMcpEventSubscriber({ server: { type: "http", url }, port });
    cleanup.push(
      () => subscriber.close(),
      () => new Promise<void>((r) => server.close(() => r())),
    );
    return { subs, subscriber };
  }

  it("verifyMcpEventSignature rejects a missing signature", () => {
    expect(verifyMcpEventSignature("s", "body", undefined)).toBe(false);
    expect(verifyMcpEventSignature("s", "body", signMcpEvent("s", "body"))).toBe(true);
  });

  it("answers 400 to a signed body that is not a delivery for this subscription", async () => {
    const { subs, subscriber } = await setup();
    const got: McpEventDelivery[] = [];
    await subscriber.subscribe({ onEvent: (d) => void got.push(d) });
    const s = subs[0] as Sub;
    for (const body of [
      "not json",
      "null",
      "42",
      JSON.stringify({ type: "x" }),
      JSON.stringify({ subscriptionId: "other" }),
    ]) {
      expect(await deliver(s, body, signMcpEvent(s.secret, body))).toBe(400);
    }
    expect(got).toHaveLength(0);
  });

  it("answers 404 to a non-POST or an unknown token", async () => {
    const { subs, subscriber } = await setup();
    await subscriber.subscribe({ onEvent: () => {} });
    const s = subs[0] as Sub;
    expect((await fetch(s.callbackUrl)).status).toBe(404);
    expect(
      (await fetch(`${s.callbackUrl.replace(/[^/]+$/, "unknown")}`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(404);
  });

  it("refuses an oversized body", async () => {
    const { subs, subscriber } = await setup();
    const got: McpEventDelivery[] = [];
    await subscriber.subscribe({ onEvent: (d) => void got.push(d) });
    const s = subs[0] as Sub;
    const body = JSON.stringify({ subscriptionId: "sub-1", pad: "a".repeat(1024 * 1024 + 10) });
    const status = await deliver(s, body, signMcpEvent(s.secret, body)).catch(() => 413);
    expect(status).toBe(413);
    expect(got).toHaveLength(0);
  });

  it("keeps receiving after onEvent throws or rejects", async () => {
    const { subs, subscriber } = await setup();
    let calls = 0;
    await subscriber.subscribe({
      onEvent: async () => {
        calls++;
        throw new Error("boom");
      },
    });
    const s = subs[0] as Sub;
    const body = JSON.stringify({ subscriptionId: "sub-1" });
    expect(await deliver(s, body, signMcpEvent(s.secret, body))).toBe(204);
    expect(await deliver(s, body, signMcpEvent(s.secret, body))).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
  });

  it("throws NetworkError on a JSON-RPC error from events/subscribe", async () => {
    const { subscriber } = await setup({ errorOn: "events/subscribe" });
    await expect(subscriber.subscribe({ onEvent: () => {} })).rejects.toThrow(/nope/);
  });

  it.each([
    [{}],
    [{ subscriptionId: "" }],
    [{ subscriptionId: 5 }],
  ])("throws when events/subscribe returns no usable subscriptionId %#", async (subscribeResult) => {
    const { subscriber } = await setup({ subscribeResult });
    await expect(subscriber.subscribe({ onEvent: () => {} })).rejects.toThrow(/no subscriptionId/);
  });

  it("unsubscribe calls events/unsubscribe and stops deliveries", async () => {
    const methods: string[] = [];
    const { subs, subscriber } = await setup({ methods });
    const sub = await subscriber.subscribe({ onEvent: () => {} });
    const second = await subscriber.subscribe({ onEvent: () => {} });
    expect(second.subscriptionId).toBe("sub-2");
    await sub.unsubscribe();
    expect(methods).toContain("events/unsubscribe");
    const s = subs[0] as Sub;
    const body = JSON.stringify({ subscriptionId: "sub-1" });
    expect(await deliver(s, body, signMcpEvent(s.secret, body))).toBe(404);
  });

  it("close before subscribe is a no-op and a failed unsubscribe surfaces", async () => {
    const { subscriber } = await setup({ errorOn: "events/unsubscribe" });
    await subscriber.close();
    const sub = await subscriber.subscribe({ onEvent: () => {} });
    await expect(sub.unsubscribe()).rejects.toThrow(/nope/);
  });

  it("rejects when the receiver cannot listen", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const { port } = blocker.address() as AddressInfo;
    const { subscriber } = await setup({}, port);
    await expect(subscriber.subscribe({ onEvent: () => {} })).rejects.toThrow(/EADDRINUSE/);
  });
});
