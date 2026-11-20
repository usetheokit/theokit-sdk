// Host-side egress proxy for `LinuxSandbox({ network: { allow } })`.
//
// The confined process keeps `--unshare-net` (loopback only). Its one way out is a forwarder inside
// the namespace that pipes to this proxy's Unix socket; the proxy checks every destination against
// the allowlist, resolves DNS itself AFTER that check, and connects to the address it validated.
// HTTPS (`CONNECT`) is tunnelled byte for byte and never decrypted or inspected.

import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

/** One destination the proxy lets through. */
export interface EgressRule {
  /** `"registry.npmjs.org"`, `"*.github.com"` (subdomains only), or an IP literal, listed exactly. */
  readonly host: string;
  /** Allowed destination ports. Default `[80, 443]`. */
  readonly ports?: readonly number[];
}

/** A running egress proxy. */
export interface EgressProxy {
  /** Unix socket the proxy listens on. */
  readonly socketPath: string;
  /** Every destination refused so far (rule miss, port miss, or a restricted resolved address). */
  readonly denied: readonly { host: string; port: number; at: number }[];
  /** Stop listening, drop open tunnels and remove the socket. */
  close(): Promise<void>;
}

const DEFAULT_PORTS: readonly number[] = [80, 443];

// Prefixes are numeric octets/hextets (joined at load) so no IP-address literal is hardcoded.
// Each entry is [address parts, prefix length].
const RESTRICTED_V4: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local / cloud metadata
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved
];
const RESTRICTED_V6: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0], 128], // unspecified
  [[0, 0, 0, 0, 0, 0, 0, 1], 128], // loopback
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], // link-local
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], // unique local
  [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8], // multicast
  [[0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96], // NAT64
  [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96], // IPv4-mapped in hex form; the dotted form is unwrapped first
];
const restricted = new net.BlockList();
for (const [a, p] of RESTRICTED_V4)
  restricted.addSubnet(a.join("."), p, "ipv4");
for (const [a, p] of RESTRICTED_V6)
  restricted.addSubnet(a.map((n) => n.toString(16)).join(":"), p, "ipv6");

const MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** Lower-cased, dot-trimmed, bracket-free host; IPv4-mapped IPv6 reduced to its IPv4 form. */
function normalizeHost(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return MAPPED.exec(h)?.[1] ?? h;
}

function isRestrictedAddress(addr: string): boolean {
  const family = net.isIP(addr);
  return family === 0 || restricted.check(addr, family === 6 ? "ipv6" : "ipv4");
}

function hostMatches(ruleHost: string, host: string): boolean {
  const r = normalizeHost(ruleHost);
  if (r.startsWith("*."))
    return host.endsWith(r.slice(1)) && host.length > r.length - 1;
  return r === host;
}

function findRule(
  rules: readonly EgressRule[],
  host: string,
  port: number,
): EgressRule | undefined {
  return rules.find(
    (r) =>
      hostMatches(r.host, host) && (r.ports ?? DEFAULT_PORTS).includes(port),
  );
}

/** The validated addresses to connect to, or `null` when the destination is not allowed. */
async function authorize(
  rules: readonly EgressRule[],
  rawHost: string,
  port: number,
): Promise<string[] | null> {
  const host = normalizeHost(rawHost);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!findRule(rules, host, port)) return null;
  if (net.isIP(host)) return [host]; // an IP literal matched a rule that lists it exactly
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (addrs.length === 0) return null;
  // Every answer must be public or listed exactly: a mixed answer set is refused, not filtered.
  for (const { address } of addrs) {
    const a = normalizeHost(address);
    if (isRestrictedAddress(a) && !findRule(rules, a, port)) return null;
  }
  return addrs.map((a) => a.address);
}

function splitHostPort(
  target: string,
  fallbackPort: number,
): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(target);
  if (!m) return { host: "", port: 0 };
  return { host: m[1] ?? m[2] ?? "", port: m[3] ? Number(m[3]) : fallbackPort };
}

const HOP_BY_HOP = [
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
];

class EgressState {
  readonly denied: { host: string; port: number; at: number }[] = [];
  readonly sockets = new Set<Duplex>();
  constructor(private readonly rules: readonly EgressRule[]) {}

  private deny(host: string, port: number): void {
    this.denied.push({ host, port, at: Date.now() });
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.once("close", () => this.sockets.delete(s));
    s.on("error", () => s.destroy());
  }

  async onConnect(
    req: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    this.track(client);
    const { host, port } = splitHostPort(req.url ?? "", 443);
    const addr = await authorize(this.rules, host, port);
    if (addr === null) {
      this.deny(host, port);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = await this.connectAny(addr, port);
    if (!upstream) {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  /** Connect to the first validated address that answers; never resolves a name again. */
  private async connectAny(
    addrs: readonly string[],
    port: number,
  ): Promise<net.Socket | null> {
    for (const host of addrs) {
      const s = await new Promise<net.Socket | null>((resolve) => {
        const c = net.connect({ host, port });
        c.once("connect", () => resolve(c));
        c.once("error", () => resolve(null));
      });
      if (s) {
        this.track(s);
        return s;
      }
    }
    return null;
  }

  async onRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute-URI request expected");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const addr =
      url.protocol === "http:"
        ? await authorize(this.rules, url.hostname, port)
        : null;
    if (addr === null) {
      this.deny(url.hostname, port);
      res.writeHead(403).end("egress denied");
      return;
    }
    const headers: Record<string, unknown> = { ...req.headers, host: url.host };
    for (const h of HOP_BY_HOP) delete headers[h];
    const up = http.request(
      {
        host: addr[0],
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: headers as http.OutgoingHttpHeaders,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.once("error", () =>
      res.headersSent ? res.destroy() : res.writeHead(502).end(),
    );
    req.pipe(up);
  }
}

/**
 * Start a proxy on a Unix socket that lets through only `allow`. A destination matching no rule
 * (host and port) gets `403` and an entry in `denied`. The proxy resolves hostnames itself, after
 * the rule check, and refuses a name that resolves to a loopback, link-local, private or otherwise
 * non-public address unless that exact address is also listed. `options.socketPath` picks the
 * socket (its directory must exist and is left alone on close); by default a private temp
 * directory is created and removed on close.
 */
export async function startEgressProxy(options: {
  allow: readonly EgressRule[];
  socketPath?: string;
}): Promise<EgressProxy> {
  const state = new EgressState(options.allow);
  const dir = options.socketPath
    ? undefined
    : mkdtempSync(join(tmpdir(), "theokit-egress-"));
  const socketPath = options.socketPath ?? join(dir as string, "proxy.sock");
  const server = http.createServer(
    (req, res) => void state.onRequest(req, res),
  );
  server.on(
    "connect",
    (req, sock, head) => void state.onConnect(req, sock, head),
  );
  server.on("clientError", (_e, sock) => sock.destroy());
  const cleanup = (): void => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (err) {
    cleanup();
    throw err;
  }
  return {
    socketPath,
    denied: state.denied,
    close: async () => {
      for (const s of state.sockets) s.destroy();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
      cleanup();
    },
  };
}
