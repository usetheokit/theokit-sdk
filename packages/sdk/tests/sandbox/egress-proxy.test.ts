import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EgressCa } from "../../src/sandbox/egress-ca.js";
import { setUpstreamCaForTests } from "../../src/sandbox/egress-proxy.js";
import { type EgressProxy, startEgressProxy } from "../../src/sandbox/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function testServer(): Promise<number> {
  const server = http.createServer((_req, res) => res.end("hello"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as net.AddressInfo).port;
}

async function proxy(allow: Parameters<typeof startEgressProxy>[0]["allow"]): Promise<EgressProxy> {
  const p = await startEgressProxy({ allow });
  cleanups.push(() => p.close());
  return p;
}

function connectVia(p: EgressProxy, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(p.socketPath);
    let buf = "";
    s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n") && buf.includes("200")) {
        s.write("GET / HTTP/1.0\r\n\r\n");
      }
    });
    s.on("close", () => resolve(buf));
    s.on("error", reject);
  });
}

describe("egress proxy", () => {
  it("egress_proxy_allows_listed_host_and_refuses_others", async () => {
    const port = await testServer();
    const p = await proxy([{ host: "127.0.0.1", ports: [port] }]);

    const ok = await connectVia(p, `127.0.0.1:${port}`);
    expect(ok).toContain("200 Connection Established");
    expect(ok).toContain("hello");

    const refused = await connectVia(p, "example.com:443");
    expect(refused).toContain("403");
    const wrongPort = await connectVia(p, `127.0.0.1:${port + 1}`);
    expect(wrongPort).toContain("403");
    expect(p.denied.map((d) => d.host)).toEqual(["example.com", "127.0.0.1"]);
    expect(p.denied[0]?.port).toBe(443);
  });

  it("forwards absolute-URI http requests and refuses unlisted ones", async () => {
    const port = await testServer();
    const p = await proxy([{ host: "127.0.0.1", ports: [port] }]);
    const get = (url: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { socketPath: p.socketPath, path: url, headers: { host: new URL(url).host } },
          (res) => {
            let body = "";
            res.on("data", (d) => {
              body += d;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject).end();
      });
    expect(await get(`http://127.0.0.1:${port}/x`)).toEqual({ status: 200, body: "hello" });
    expect((await get("http://127.0.0.1:1/x")).status).toBe(403);
    expect(p.denied).toHaveLength(1);
  });

  it("egress_proxy_refuses_private_address_behind_a_listed_name", async () => {
    const port = await testServer();
    // `localhost` is listed but resolves to loopback, which is not listed.
    const p = await proxy([{ host: "localhost", ports: [port] }]);
    expect(await connectVia(p, `localhost:${port}`)).toContain("403");
    expect(p.denied).toHaveLength(1);

    const q = await proxy([
      { host: "localhost", ports: [port] },
      { host: "127.0.0.1", ports: [port] },
      { host: "::1", ports: [port] },
    ]);
    expect(await connectVia(q, `localhost:${port}`)).toContain("200");
  });

  it("matches wildcards on subdomains only", async () => {
    const p = await proxy([{ host: "*.example.invalid" }]);
    expect(await connectVia(p, "example.invalid:443")).toContain("403");
    expect(await connectVia(p, "evilexample.invalid:443")).toContain("403");
    expect(p.denied).toHaveLength(2);
  });

  it("close removes the socket", async () => {
    const p = await startEgressProxy({ allow: [] });
    await p.close();
    await expect(connectVia(p, "x:1")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("egress proxy credential injection", () => {
  const REAL = "real-secret-value-9f3a";
  const PLACEHOLDER = "THEOKIT_PLACEHOLDER_GITHUB";
  const upstreamCa = new EgressCa();
  beforeEach(() => setUpstreamCaForTests(upstreamCa.certPem));
  afterEach(() => setUpstreamCaForTests(undefined));

  async function httpsServer(seen: http.IncomingHttpHeaders[]): Promise<number> {
    const leaf = upstreamCa.issue("127.0.0.1");
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      seen.push(req.headers);
      res.end("secure-hello");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    return (server.address() as net.AddressInfo).port;
  }

  async function credProxy(port: number, otherPort: number, lines: string[]): Promise<EgressProxy> {
    const p = await startEgressProxy({
      allow: [
        { host: "127.0.0.1", ports: [port] },
        { host: "localhost", ports: [otherPort] },
      ],
      credentials: [
        {
          host: "127.0.0.1",
          header: "authorization",
          value: async () => REAL,
          placeholder: PLACEHOLDER,
        },
      ],
      log: (l) => lines.push(l),
    });
    cleanups.push(() => p.close());
    return p;
  }

  /** HTTPS GET to `host:port` through the proxy, trusting the proxy's CA. */
  function getVia(
    p: EgressProxy,
    host: string,
    port: number,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const s = net.connect(p.socketPath);
      s.once("error", reject);
      s.once("connect", () =>
        s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`),
      );
      s.once("data", () => {
        const req = https.request(
          {
            createConnection: () =>
              tls.connect({
                socket: s,
                host,
                servername: net.isIP(host) ? undefined : host,
                ca: p.caCertPem,
              }),
            host,
            port,
            path: "/",
            headers,
          },
          (res) => {
            let body = "";
            res.on("data", (d) => {
              body += d;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.once("error", reject);
        req.end();
      });
    });
  }

  it("proxy_injects_credential_for_its_host", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await httpsServer(seen);
    const p = await credProxy(port, port + 1, []);
    const r = await getVia(p, "127.0.0.1", port, { authorization: `Bearer ${PLACEHOLDER}` });
    expect(r).toEqual({ status: 200, body: "secure-hello" });
    expect(seen[0]?.authorization).toBe(`Bearer ${REAL}`);
    const absent = await getVia(p, "127.0.0.1", port, {});
    expect(absent.status).toBe(200);
    expect(seen[1]?.authorization).toBe(REAL);
  });

  it("placeholder_to_another_host_is_refused", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await httpsServer(seen);
    const other: http.IncomingHttpHeaders[] = [];
    const otherServer = http.createServer((req, res) => {
      other.push(req.headers);
      res.end("x");
    });
    await new Promise<void>((r) => otherServer.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => otherServer.close(() => r())));
    const otherPort = (otherServer.address() as net.AddressInfo).port;
    const lines: string[] = [];
    const p = await credProxy(port, otherPort, lines);
    const res = await new Promise<number>((resolve, reject) => {
      http
        .request(
          {
            socketPath: p.socketPath,
            path: `http://localhost:${otherPort}/`,
            headers: { authorization: PLACEHOLDER, host: `localhost:${otherPort}` },
          },
          (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          },
        )
        .once("error", reject)
        .end();
    });
    expect(res).toBe(403);
    expect(other).toHaveLength(0);
    expect(p.denied.at(-1)?.reason).toBe("credential_misroute");
    expect(lines.join("\n")).toContain("credential_misroute");
  });

  it("credential_rule_for_unlisted_host_is_refused", async () => {
    await expect(
      startEgressProxy({
        allow: [{ host: "a.example.com" }],
        credentials: [
          { host: "b.example.com", header: "authorization", value: () => "x", placeholder: "P1" },
        ],
      }),
    ).rejects.toMatchObject({ code: "credential_host_not_allowed" });
  });

  it("real_value_never_logged", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await httpsServer(seen);
    const lines: string[] = [];
    const p = await credProxy(port, port + 1, lines);
    await getVia(p, "127.0.0.1", port, { authorization: PLACEHOLDER });
    await getVia(p, "127.0.0.1", port, { "x-other": PLACEHOLDER });
    const dump = JSON.stringify(p.denied) + lines.join("\n");
    expect(dump).not.toContain("real-secret-value");
  });

  it("refuses an upstream whose certificate does not verify", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await httpsServer(seen);
    setUpstreamCaForTests(undefined); // the test upstream's CA is unknown, so verification fails
    const p = await startEgressProxy({
      allow: [{ host: "127.0.0.1", ports: [port] }],
      credentials: [
        { host: "127.0.0.1", header: "authorization", value: () => REAL, placeholder: PLACEHOLDER },
      ],
    });
    cleanups.push(() => p.close());
    const r = await getVia(p, "127.0.0.1", port, { authorization: PLACEHOLDER });
    expect(r.status).toBe(502);
    expect(seen).toHaveLength(0);
  });

  it("returns 502 without leaking when value() throws", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await httpsServer(seen);
    const p = await startEgressProxy({
      allow: [{ host: "127.0.0.1", ports: [port] }],
      credentials: [
        {
          host: "127.0.0.1",
          header: "authorization",
          value: () => {
            throw new Error(REAL);
          },
          placeholder: PLACEHOLDER,
        },
      ],
    });
    cleanups.push(() => p.close());
    const r = await getVia(p, "127.0.0.1", port, {});
    expect(r.status).toBe(502);
    expect(r.body).not.toContain("real-secret");
    expect(seen).toHaveLength(0);
  });
});
