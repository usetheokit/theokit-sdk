import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { type EgressProxy, startEgressProxy } from "../../src/sandbox/index.js";
import { isRestrictedAddress } from "../../src/sandbox/egress-proxy.js";

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
          {
            socketPath: p.socketPath,
            path: url,
            headers: { host: new URL(url).host },
          },
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
    expect(await get(`http://127.0.0.1:${port}/x`)).toEqual({
      status: 200,
      body: "hello",
    });
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
    await expect(connectVia(p, "x:1")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("restricted address ranges", () => {
  const blocked = [
    // [first, last] of each restricted range
    ["0.0.0.0", "0.255.255.255"],
    ["10.0.0.0", "10.255.255.255"],
    ["100.64.0.0", "100.127.255.255"],
    ["127.0.0.0", "127.255.255.255"],
    ["169.254.0.0", "169.254.255.255"],
    ["172.16.0.0", "172.31.255.255"],
    ["192.0.0.0", "192.0.0.255"],
    ["192.168.0.0", "192.168.255.255"],
    ["198.18.0.0", "198.19.255.255"],
    ["224.0.0.0", "239.255.255.255"],
    ["240.0.0.0", "255.255.255.255"],
    ["::", "::"],
    ["::1", "::1"],
    ["fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["64:ff9b::", "64:ff9b::ffff:ffff"],
    ["::ffff:0:0", "::ffff:ffff:ffff"],
  ] as const;
  const allowed = [
    "1.0.0.1",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "191.255.255.255",
    "192.0.1.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "fec0::",
    "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe00::",
    "feff::",
    "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff",
    "64:ff9c::",
    "::2",
    "::1:0:0",
    "::fffe:ffff:ffff",
    "::1:0:0:0",
  ];

  it.each(blocked.flat())("blocks %s", (addr) => {
    expect(isRestrictedAddress(addr)).toBe(true);
  });
  it.each(allowed)("allows %s", (addr) => {
    expect(isRestrictedAddress(addr)).toBe(false);
  });
});
