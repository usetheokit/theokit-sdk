// Pieces of the egress-proxy wiring for LinuxSandbox: the in-namespace forwarder, the proxy
// variables, and the credential placeholders. Split out of linux-sandbox.ts.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";

import {
  type CredentialRule,
  type EgressProxy,
  type EgressRule,
  startEgressProxy,
} from "./egress-proxy.js";
import { shellEscapePosix } from "./shell-escape.js";

/** Name of the trust bundle (system roots plus the proxy CA) written beside the proxy socket. */
export const CA_BUNDLE_NAME = "ca-bundle.pem";

/** Placeholders and CA-trust variables a confined command gets when credentials are configured. */
export function credentialEnv(
  credentials: readonly CredentialRule[],
  socketPath: string,
): Record<string, string> {
  if (credentials.length === 0) return {};
  const bundle = join(dirname(socketPath), CA_BUNDLE_NAME);
  const env: Record<string, string> = {
    SSL_CERT_FILE: bundle,
    NODE_EXTRA_CA_CERTS: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    GIT_SSL_CAINFO: bundle,
  };
  for (const c of credentials) if (c.envVar) env[c.envVar] = c.placeholder;
  return env;
}

/** Loopback port the in-namespace forwarder listens on; a fresh network namespace has it free. */
export const EGRESS_PORT = 3128;

/**
 * The in-namespace forwarder is the Node binary the host already runs. It listens on
 * `127.0.0.1:EGRESS_PORT`, pipes each connection to the proxy's Unix socket, and only once it is
 * listening spawns the real command, so the proxy is reachable from the command's first instruction.
 * It exits with the command's status. If it cannot listen it exits 126 without running the command.
 */
const FORWARDER_SOURCE = `
const net = require("net");
const { spawn } = require("child_process");
const [sock, port, cmd] = process.argv.slice(1);
const srv = net.createServer((c) => {
  const u = net.connect(sock);
  c.pipe(u); u.pipe(c);
  c.on("error", () => u.destroy()); u.on("error", () => c.destroy());
  c.on("close", () => u.destroy()); u.on("close", () => c.destroy());
});
srv.on("error", (e) => { console.error("egress forwarder: " + e.message); process.exit(126); });
srv.listen(Number(port), "127.0.0.1", () => {
  const ch = spawn("/bin/sh", ["-c", cmd], { stdio: "inherit" });
  ch.on("exit", (code, sig) => process.exit(code === null ? (sig ? 128 : 1) : code));
});
`;

export function forwarderCommand(socketPath: string, command: string): string {
  const words = [process.execPath, "-e", FORWARDER_SOURCE, "--", socketPath, String(EGRESS_PORT)];
  return `exec ${[...words, command].map(shellEscapePosix).join(" ")}`;
}

/** The proxy variables a confined command gets under an allowlist. */
export function proxyEnv(): Record<string, string> {
  const url = `http://127.0.0.1:${EGRESS_PORT}`;
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "" };
}

/** Create the socket directory now (so the wrap is synchronous) and start the proxy in it. */
export function startProxyFor(
  allow: readonly EgressRule[],
  credentials: readonly CredentialRule[],
): {
  socketPath: string;
  dir: string;
  ready: Promise<EgressProxy>;
} {
  const dir = mkdtempSync(join(tmpdir(), "theokit-egress-"));
  const socketPath = join(dir, "proxy.sock");
  const ready = startEgressProxy({ allow, credentials, socketPath }).then((proxy) => {
    if (proxy.caCertPem) {
      // System roots stay trusted, so a command's other HTTPS traffic still verifies.
      const pem = `${tls.rootCertificates.join("\n")}\n${proxy.caCertPem}`;
      writeFileSync(join(dir, CA_BUNDLE_NAME), pem, { mode: 0o444 });
    }
    return proxy;
  });
  ready.catch(() => undefined); // surfaced by `execute`, not as an unhandled rejection
  return { socketPath, dir, ready };
}
