// Host-side egress proxy for `LinuxSandbox({ network: { allow } })`.
//
// The confined process keeps `--unshare-net` (loopback only). Its one way out is a forwarder inside
// the namespace that pipes to this proxy's Unix socket; the proxy checks every destination against
// the allowlist, resolves DNS itself AFTER that check, and connects to the address it validated.
// HTTPS (`CONNECT`) is tunnelled byte for byte and never decrypted or inspected, except to a host
// with a `CredentialRule`: that connection is terminated here with a certificate from a per-proxy
// CA, so the proxy can swap the rule's placeholder for the real credential before re-encrypting
// the request toward the verified upstream.

import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import { EgressCa } from "./egress-ca.js";
import {
  BAD_HEADER_VALUE,
  type CredentialRule,
  type EgressRule,
  hostMatches,
  normalizeHost,
  validateCredentialRules,
} from "./egress-credential-rules.js";

export type { CredentialRule, EgressRule } from "./egress-credential-rules.js";
export { validateCredentialRules } from "./egress-credential-rules.js";

/** A running egress proxy. */
export interface EgressProxy {
  /** Unix socket the proxy listens on. */
  readonly socketPath: string;
  /** Every destination refused so far (rule miss, port miss, or a restricted resolved address). */
  readonly denied: readonly { host: string; port: number; at: number; reason?: string }[];
  /** PEM of the CA that signs certificates for credential hosts; absent without credential rules. */
  readonly caCertPem?: string;
  /** Stop listening, drop open tunnels and remove the socket. */
  close(): Promise<void>;
}

const DEFAULT_PORTS: readonly number[] = [80, 443];

// Prefixes are kept as numeric components (octets / 16-bit groups) and joined into the address
// text only when the blocklists are built.
const RESTRICTED_V4: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];
const RESTRICTED_V6: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0], 128], // unspecified
  [[0, 0, 0, 0, 0, 0, 0, 1], 128], // loopback
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7],
  [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8],
  [[0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96],
  [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96], // IPv4-mapped in hex form; the dotted form is unwrapped first
];
const restrictedV4 = new net.BlockList();
for (const [o, p] of RESTRICTED_V4) restrictedV4.addSubnet(o.join("."), p, "ipv4");
const restrictedV6 = new net.BlockList();
for (const [g, p] of RESTRICTED_V6) {
  restrictedV6.addSubnet(g.map((x) => x.toString(16)).join(":"), p, "ipv6");
}

function isRestrictedAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 0) return true;
  return family === 6 ? restrictedV6.check(addr, "ipv6") : restrictedV4.check(addr, "ipv4");
}

function findRule(
  rules: readonly EgressRule[],
  host: string,
  port: number,
): EgressRule | undefined {
  return rules.find((r) => hostMatches(r.host, host) && (r.ports ?? DEFAULT_PORTS).includes(port));
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

function splitHostPort(target: string, fallbackPort: number): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(target);
  if (!m) return { host: "", port: 0 };
  return { host: m[1] ?? m[2] ?? "", port: m[3] ? Number(m[3]) : fallbackPort };
}

const HOP_BY_HOP = ["proxy-connection", "proxy-authorization", "connection", "keep-alive"];

interface EgressStateOptions {
  credentials: readonly CredentialRule[];
  ca: EgressCa | undefined;
  log: (line: string) => void;
  upstreamCa: string | undefined;
}

/** The host and validated addresses of a connection the proxy terminates TLS for. */
interface Intercept {
  host: string;
  port: number;
  addrs: string[];
}

class EgressState {
  readonly denied: { host: string; port: number; at: number; reason?: string }[] = [];
  readonly sockets = new Set<Duplex>();
  private readonly intercepts = new WeakMap<Duplex, Intercept>();
  /** Plain HTTP server fed the decrypted streams; never listens on a port. */
  readonly inner = http.createServer((req, res) => void this.onIntercepted(req, res));

  constructor(
    private readonly rules: readonly EgressRule[],
    private readonly opts: EgressStateOptions,
  ) {
    this.inner.on("clientError", (_e, sock) => sock.destroy());
  }

  private deny(host: string, port: number, reason?: string): void {
    this.denied.push(
      reason ? { host, port, at: Date.now(), reason } : { host, port, at: Date.now() },
    );
  }

  private credentialRulesFor(host: string): CredentialRule[] {
    return this.opts.credentials.filter((c) => hostMatches(c.host, host));
  }

  /** The first rule whose placeholder appears in `text`, ignoring rules for `host`. */
  private foreignPlaceholder(host: string, texts: readonly string[]): CredentialRule | undefined {
    return this.opts.credentials.find(
      (c) => !hostMatches(c.host, host) && texts.some((t) => t.includes(c.placeholder)),
    );
  }

  private misroute(host: string, port: number, rule: CredentialRule): void {
    this.deny(host, port, "credential_misroute");
    this.opts.log(
      `credential_misroute: placeholder for ${rule.host} (${rule.header}) sent to ${host}:${port}`,
    );
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.once("close", () => this.sockets.delete(s));
    s.on("error", () => s.destroy());
  }

  async onConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    this.track(client);
    const { host, port } = splitHostPort(req.url ?? "", 443);
    const addr = await authorize(this.rules, host, port);
    if (addr === null) {
      this.deny(host, port);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (this.opts.ca && this.credentialRulesFor(normalizeHost(host)).length > 0) {
      this.terminate(client, head, { host: normalizeHost(host), port, addrs: addr });
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
  private async connectAny(addrs: readonly string[], port: number): Promise<net.Socket | null> {
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

  async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute-URI request expected");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const leaked = this.placeholderInPlainRequest(req);
    if (leaked) {
      // Never inject over plaintext, and never let a placeholder travel to a host.
      this.misroute(url.hostname, port, leaked);
      res.writeHead(403).end("egress denied");
      return;
    }
    const addr = url.protocol === "http:" ? await authorize(this.rules, url.hostname, port) : null;
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
      (r) => relayResponse(r, res),
    );
    relayRequest(req, res, up);
  }

  private placeholderInPlainRequest(req: http.IncomingMessage): CredentialRule | undefined {
    const texts = [req.url ?? "", ...headerTexts(req.headers)];
    return this.opts.credentials.find((c) => texts.some((t) => t.includes(c.placeholder)));
  }

  /** Answer the CONNECT, then speak TLS to the client with a certificate for `target.host`. */
  private terminate(client: Duplex, head: Buffer, target: Intercept): void {
    const ca = this.opts.ca as EgressCa;
    let leaf: ReturnType<EgressCa["issue"]>;
    try {
      leaf = ca.issue(target.host);
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) client.unshift(head);
    const secure = new tls.TLSSocket(client as net.Socket, {
      isServer: true,
      secureContext: tls.createSecureContext({ key: leaf.key, cert: leaf.cert }),
    });
    this.track(secure);
    this.intercepts.set(secure, target);
    this.inner.emit("connection", secure);
  }

  private async onIntercepted(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = this.intercepts.get(req.socket);
    if (!target) {
      res.writeHead(400).end();
      return;
    }
    const foreign = this.foreignPlaceholder(target.host, [
      req.url ?? "",
      ...headerTexts(req.headers),
    ]);
    if (foreign) {
      this.misroute(target.host, target.port, foreign);
      res.writeHead(403).end("egress denied");
      return;
    }
    let headers: http.OutgoingHttpHeaders;
    try {
      headers = await this.withCredentials(req, target);
    } catch {
      res.writeHead(502).end("credential unavailable"); // never echo the cause: it may hold the value
      return;
    }
    this.forwardTls(req, res, target, headers);
  }

  /** Request headers with each matching rule's placeholder swapped for its value (or the header set). */
  private async withCredentials(
    req: http.IncomingMessage,
    target: Intercept,
  ): Promise<http.OutgoingHttpHeaders> {
    const headers: Record<string, unknown> = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    headers.host = target.port === 443 ? target.host : `${target.host}:${target.port}`;
    for (const rule of this.credentialRulesFor(target.host)) {
      const name = rule.header.toLowerCase();
      headers[name] = substitute(headers[name], rule.placeholder, await rule.value());
    }
    return headers as http.OutgoingHttpHeaders;
  }

  private forwardTls(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: Intercept,
    headers: http.OutgoingHttpHeaders,
  ): void {
    const up = https.request(
      {
        host: target.addrs[0],
        servername: net.isIP(target.host) ? undefined : target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
        agent: false,
        ...(this.opts.upstreamCa ? { ca: this.opts.upstreamCa } : {}),
      },
      (r) => relayResponse(r, res),
    );
    relayRequest(req, res, up);
  }
}

function relayResponse(r: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(r.statusCode ?? 502, r.headers);
  r.pipe(res);
}

function relayRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  up: http.ClientRequest,
): void {
  up.once("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
  req.pipe(up);
}

/** `current` with `placeholder` replaced by `value`, or `value` alone when the header was absent. */
function substitute(current: unknown, placeholder: string, value: unknown): string {
  if (typeof value !== "string" || value === "" || BAD_HEADER_VALUE.test(value)) {
    throw new Error("invalid credential value");
  }
  const text = Array.isArray(current) ? current.join(", ") : current;
  return typeof text === "string" ? text.split(placeholder).join(value) : value;
}

function headerTexts(headers: http.IncomingHttpHeaders): string[] {
  return Object.entries(headers).flatMap(([k, v]) => [k, ...(Array.isArray(v) ? v : [v ?? ""])]);
}

let upstreamCaForTests: string | undefined;

/** Test seam, deliberately not re-exported from the entry point: the upstream roots a proxy started next trusts. */
export function setUpstreamCaForTests(pem: string | undefined): void {
  upstreamCaForTests = pem;
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
  /** Credentials added for their hosts; see `CredentialRule`. HTTPS to those hosts is terminated here. */
  credentials?: readonly CredentialRule[];
  socketPath?: string;
  /** Receives one secret-free line per notable event (a `credential_misroute`). Default: none. */
  log?: (line: string) => void;
}): Promise<EgressProxy> {
  const credentials = options.credentials ?? [];
  validateCredentialRules(options.allow, credentials);
  const ca = credentials.length > 0 ? new EgressCa() : undefined;
  const state = new EgressState(options.allow, {
    credentials,
    ca,
    log: options.log ?? (() => undefined),
    upstreamCa: upstreamCaForTests,
  });
  const dir = options.socketPath ? undefined : mkdtempSync(join(tmpdir(), "theokit-egress-"));
  const socketPath = options.socketPath ?? join(dir as string, "proxy.sock");
  const server = http.createServer((req, res) => void state.onRequest(req, res));
  server.on("connect", (req, sock, head) => void state.onConnect(req, sock, head));
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
    ca?.destroy();
    cleanup();
    throw err;
  }
  return {
    socketPath,
    denied: state.denied,
    caCertPem: ca?.certPem,
    close: async () => {
      for (const s of state.sockets) s.destroy();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      state.inner.closeAllConnections();
      await closed;
      ca?.destroy();
      cleanup();
    },
  };
}
