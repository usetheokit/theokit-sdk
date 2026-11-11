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
} from "../../src/mcp-events.js";

interface Sub {
  id: string;
  callbackUrl: string;
  secret: string;
}

type Rpc = { id: number; method: string; params: Record<string, string> };
type Mode = "ok" | "error" | "no-id";

function answer(msg: Rpc, mode: Mode, subs: Sub[]): Record<string, unknown> {
  const base = { jsonrpc: "2.0", id: msg.id };
  if (mode === "error") return { ...base, error: { message: "nope" } };
  if (msg.method !== "events/subscribe") return { ...base, result: {} };
  if (mode === "no-id") return { ...base, result: {} };
  const id = `sub-${subs.length + 1}`;
  subs.push({
    id,
    callbackUrl: msg.params.callbackUrl as string,
    secret: msg.params.secret as string,
  });
  return { ...base, result: { subscriptionId: id } };
}

async function startServer(
  subs: Sub[],
  mode: Mode = "ok",
  methods: string[] = [],
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const msg = JSON.parse(raw) as Rpc;
      methods.push(msg.method);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(msg, mode, subs)));
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

  async function setup(mode: "ok" | "error" | "no-id" = "ok", callbackOrigin?: string) {
    const subs: Sub[] = [];
    const methods: string[] = [];
    const { server, url } = await startServer(subs, mode, methods);
    const subscriber = createMcpEventSubscriber({
      server: { type: "http", url },
      ...(callbackOrigin !== undefined ? { callbackOrigin } : {}),
    });
    cleanup.push(
      () => subscriber.close(),
      () => new Promise<void>((r) => server.close(() => r())),
    );
    return { subs, methods, subscriber };
  }

  it("answers 404 for an unknown token or a non-POST request", async () => {
    const { subs, subscriber } = await setup();
    await subscriber.subscribe({ onEvent: () => undefined });
    const s = subs[0] as Sub;
    expect((await fetch(s.callbackUrl)).status).toBe(404);
    expect((await fetch(s.callbackUrl.replace(/[^/]+$/, "nope"), { method: "POST" })).status).toBe(
      404,
    );
  });

  it("answers 400 for a signed body that is not a delivery for this subscription", async () => {
    const { subs, subscriber } = await setup();
    await subscriber.subscribe({ onEvent: () => undefined });
    const s = subs[0] as Sub;
    for (const body of ["not json", "null", JSON.stringify({ subscriptionId: "other" }), "{}"]) {
      expect(await deliver(s, body, signMcpEvent(s.secret, body))).toBe(400);
    }
  });

  it("answers 413 for a body over the size limit", async () => {
    const { subs, subscriber } = await setup();
    await subscriber.subscribe({ onEvent: () => undefined });
    const s = subs[0] as Sub;
    const status = await deliver(s, "x".repeat(1024 * 1024 + 10), "").catch(() => 413);
    expect(status).toBe(413);
  });

  it("throws on an rpc error and on a missing subscriptionId", async () => {
    const failing = await setup("error");
    await expect(failing.subscriber.subscribe({ onEvent: () => undefined })).rejects.toThrow(
      /nope/,
    );
    const noId = await setup("no-id");
    await expect(noId.subscriber.subscribe({ onEvent: () => undefined })).rejects.toThrow(
      /no subscriptionId/,
    );
  });

  it("unsubscribes over rpc and trims trailing slashes of the callback origin", async () => {
    const { subs, methods, subscriber } = await setup(
      "ok",
      `https://hooks.example.com${"/".repeat(5000)}`,
    );
    const sub = await subscriber.subscribe({ onEvent: () => undefined });
    expect((subs[0] as Sub).callbackUrl).toMatch(
      /^https:\/\/hooks\.example\.com\/mcp-events\/[0-9a-f]+$/,
    );
    await sub.unsubscribe();
    expect(methods).toContain("events/unsubscribe");
  });
});
