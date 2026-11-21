import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

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
