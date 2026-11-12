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

async function startServer(subs: Sub[]): Promise<{ server: Server; url: string }> {
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
      if (msg.method === "events/subscribe") {
        const sub = {
          id: `sub-${subs.length + 1}`,
          callbackUrl: msg.params.callbackUrl as string,
          secret: msg.params.secret as string,
        };
        subs.push(sub);
        reply({ subscriptionId: sub.id });
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
});
