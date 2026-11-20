import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  A2AMailboxError,
  type A2AMessage,
  createHttpMailboxHandler,
  httpMailboxTransport,
  MessageBus,
} from "../../src/a2a/index.js";
import { ConfigurationError } from "../../src/errors.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

const TOKEN = "s3cret";
const URL_BASE = "http://127.0.0.1:8080/mb";

function msg(n: number, to = "worker"): A2AMessage {
  return { type: "job", payload: { n }, from: "boss", to, timestamp: n };
}

function req(route: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${URL_BASE}/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mailbox-"));
  onTestFinished(() => removeTempDirRobustSync(dir));
  return join(dir, "box.json");
}

describe("createHttpMailboxHandler", () => {
  it("answers 405 with allow: POST for GET", async () => {
    const h = createHttpMailboxHandler({ token: TOKEN });
    const res = await h(new Request(`${URL_BASE}/put`, { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("answers 401 for a wrong or missing token, before reading the body", async () => {
    const h = createHttpMailboxHandler({ token: TOKEN });
    let read = false;
    const body = new ReadableStream(
      {
        pull(c) {
          read = true;
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const bad = new Request(`${URL_BASE}/put`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body,
      duplex: "half",
    } as RequestInit);
    const res = await h(bad);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(read).toBe(false);
    expect((await h(new Request(`${URL_BASE}/take`, { method: "POST" }))).status).toBe(401);
  });

  it("answers 413 over the body cap, 400 for bad JSON/shape, 404 for unknown routes", async () => {
    const h = createHttpMailboxHandler({ token: TOKEN, maxBodyBytes: 64 });
    expect((await h(req("put", "x".repeat(200)))).status).toBe(413);
    expect((await h(req("put", "{nope"))).status).toBe(400);
    expect((await h(req("put", { message: { type: 1 } }))).status).toBe(400);
    expect((await h(req("take", {}))).status).toBe(400);
    expect((await h(req("other", {}))).status).toBe(404);
  });

  it("answers 507 for a full recipient queue, and other recipients still work", async () => {
    const h = createHttpMailboxHandler({ token: TOKEN, maxPerRecipient: 2 });
    expect((await h(req("put", { message: msg(1) }))).status).toBe(200);
    expect((await h(req("put", { message: msg(2) }))).status).toBe(200);
    expect((await h(req("put", { message: msg(3) }))).status).toBe(507);
    expect((await h(req("put", { message: msg(3, "other") }))).status).toBe(200);
  });

  it("take returns and clears the queue", async () => {
    const h = createHttpMailboxHandler({ token: TOKEN });
    await h(req("put", { message: msg(1) }));
    const first = (await (await h(req("take", { recipient: "worker" }))).json()) as {
      envelopes: A2AMessage[];
    };
    expect(first.envelopes).toEqual([msg(1)]);
    const second = (await (await h(req("take", { recipient: "worker" }))).json()) as {
      envelopes: A2AMessage[];
    };
    expect(second.envelopes).toEqual([]);
  });

  it("keeps every message under concurrent puts", async () => {
    const h = createHttpMailboxHandler({ token: TOKEN, persistPath: tmpFile() });
    await Promise.all([1, 2, 3, 4, 5].map((n) => h(req("put", { message: msg(n) }))));
    const body = (await (await h(req("take", { recipient: "worker" }))).json()) as {
      envelopes: A2AMessage[];
    };
    expect(body.envelopes.map((m) => m.timestamp).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  describe("persistence", () => {
    it("survives a new handler on the same file, with mode 0600", async () => {
      const path = tmpFile();
      const a = createHttpMailboxHandler({ token: TOKEN, persistPath: path });
      await a(req("put", { message: msg(1) }));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const b = createHttpMailboxHandler({ token: TOKEN, persistPath: path });
      const body = (await (await b(req("take", { recipient: "worker" }))).json()) as {
        envelopes: A2AMessage[];
      };
      expect(body.envelopes).toEqual([msg(1)]);
    });

    it("refuses a malformed file at start and leaves it untouched", () => {
      const path = tmpFile();
      const bad = JSON.stringify({ worker: [{ nope: true }] });
      writeFileSync(path, bad);
      expect(() => createHttpMailboxHandler({ token: TOKEN, persistPath: path })).toThrow(
        A2AMailboxError,
      );
      expect(() => createHttpMailboxHandler({ token: TOKEN, persistPath: path })).toThrow(path);
      expect(readFileSync(path, "utf8")).toBe(bad);
    });
  });
});

describe("httpMailboxTransport", () => {
  it("rejects an insecure baseUrl and accepts loopback", () => {
    for (const baseUrl of ["http://example.com", "ftp://localhost", "nonsense"]) {
      try {
        httpMailboxTransport({ baseUrl, token: TOKEN });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).code).toBe("a2a_mailbox_insecure_url");
      }
    }
    for (const baseUrl of [
      "http://127.0.0.1:8080",
      "http://localhost:1",
      "http://[::1]:1",
      "https://example.com",
    ]) {
      expect(() => httpMailboxTransport({ baseUrl, token: TOKEN })).not.toThrow();
    }
  });

  it("carries a message between two buses through one mailbox", async () => {
    const handler = createHttpMailboxHandler({ token: TOKEN });
    const fetchImpl = ((url: string, init?: RequestInit) =>
      handler(new Request(url, init))) as unknown as typeof fetch;
    const make = () =>
      new MessageBus({
        transport: httpMailboxTransport({ baseUrl: URL_BASE, token: TOKEN, fetchImpl }),
      });
    const a = make();
    const b = make();
    const got: A2AMessage[] = [];
    b.register("worker", (m) => {
      got.push(m);
    });
    await a.send("boss", "worker", { type: "job", payload: { n: 1 } });
    expect(await b.pump()).toBe(1);
    expect(got[0]?.payload).toEqual({ n: 1 });
    expect(got[0]?.from).toBe("boss");
  });

  it("rejects with A2AMailboxError carrying the status", async () => {
    const handler = createHttpMailboxHandler({ token: TOKEN });
    const fetchImpl = ((url: string, init?: RequestInit) =>
      handler(new Request(url, init))) as unknown as typeof fetch;
    const t = httpMailboxTransport({ baseUrl: URL_BASE, token: "wrong", fetchImpl });
    await expect(t.send(msg(1))).rejects.toMatchObject({ name: "A2AMailboxError", status: 401 });
    await expect(t.poll("worker")).rejects.toBeInstanceOf(A2AMailboxError);
  });
});
