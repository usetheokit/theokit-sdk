// Per-proxy certificate authority for the egress proxy's credential injection.
//
// The CA key pair is generated in memory when the proxy starts, is never written to disk and is
// dropped by `destroy()`. Certificates are built by hand in DER (X.509 v3, ECDSA P-256 / SHA-256):
// node:crypto signs but has no certificate builder, and this avoids a dependency.

import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import net from "node:net";

const DAY_MS = 86_400_000;

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  let len: Buffer;
  if (n < 0x80) len = Buffer.from([n]);
  else if (n < 0x100) len = Buffer.from([0x81, n]);
  else len = Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

const seq = (...p: Buffer[]): Buffer => der(0x30, ...p);
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, "hex"));
const utf8 = (s: string): Buffer => der(0x0c, Buffer.from(s, "utf8"));
const octets = (b: Buffer): Buffer => der(0x04, b);
const TRUE = Buffer.from("0101ff", "hex");

const OID_ECDSA_SHA256 = "2a8648ce3d040302";
const SIG_ALG = seq(oid(OID_ECDSA_SHA256));

function utcTime(ms: number): Buffer {
  const iso = new Date(ms).toISOString(); // 2026-11-20T10:11:12.000Z
  const t = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return der(0x17, Buffer.from(t, "ascii"));
}

function name(cn: string): Buffer {
  return seq(der(0x31, seq(oid("550403"), utf8(cn))));
}

function ext(oidHex: string, value: Buffer, critical: boolean): Buffer {
  return seq(oid(oidHex), ...(critical ? [TRUE] : []), octets(value));
}

function sanExt(host: string): Buffer {
  const ip = net.isIP(host);
  const entry = ip ? der(0x87, ipBytes(host, ip)) : der(0x82, Buffer.from(host, "ascii"));
  return ext("551d11", seq(entry), false);
}

function ipBytes(host: string, family: number): Buffer {
  if (family === 4) return Buffer.from(host.split(".").map(Number));
  // Expand an IPv6 literal: split on "::" then pad with zero groups.
  const [head = "", tail = ""] = host.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = host.includes("::")
    ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]
    : h;
  return Buffer.concat(groups.map((g) => Buffer.from(g.padStart(4, "0"), "hex")));
}

interface CertSpec {
  readonly cn: string;
  readonly issuerCn: string;
  readonly spki: Buffer;
  readonly signer: KeyObject;
  readonly extensions: Buffer[];
  readonly notAfterMs: number;
}

function buildCertificate(spec: CertSpec): string {
  const now = Date.now();
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 1) & 0x7f || 1; // positive and non-zero
  const tbs = seq(
    Buffer.from("a003020102", "hex"), // version 3
    der(0x02, serial),
    SIG_ALG,
    name(spec.issuerCn),
    seq(utcTime(now - DAY_MS), utcTime(spec.notAfterMs)),
    name(spec.cn),
    spec.spki,
    der(0xa3, seq(...spec.extensions)),
  );
  const signature = sign("sha256", tbs, spec.signer);
  const cert = seq(tbs, SIG_ALG, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = cert.toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}-----END CERTIFICATE-----\n`;
}

/** A certificate for one host and the key to serve it with. */
export interface LeafCertificate {
  readonly key: string;
  readonly cert: string;
}

/** An in-memory CA that issues short-lived server certificates. */
export class EgressCa {
  /** The CA certificate, PEM. Public: this is what the sandbox is told to trust. */
  readonly certPem: string;
  private signer: KeyObject | undefined;
  private readonly leaves = new Map<string, LeafCertificate>();
  private static readonly CN = "TheoKit egress proxy CA";

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.signer = privateKey;
    this.certPem = buildCertificate({
      cn: EgressCa.CN,
      issuerCn: EgressCa.CN,
      spki: publicKey.export({ type: "spki", format: "der" }),
      signer: privateKey,
      notAfterMs: Date.now() + 366 * DAY_MS,
      extensions: [
        ext("551d13", seq(TRUE), true), // basicConstraints: CA
        ext("551d0f", Buffer.from("03020106", "hex"), true), // keyCertSign, cRLSign
      ],
    });
  }

  /** A certificate for `host` signed by this CA. Throws once the CA is destroyed. */
  issue(host: string): LeafCertificate {
    const cached = this.leaves.get(host);
    if (cached) return cached;
    if (!this.signer) throw new Error("egress CA destroyed");
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const cert = buildCertificate({
      cn: host,
      issuerCn: EgressCa.CN,
      spki: publicKey.export({ type: "spki", format: "der" }),
      signer: this.signer,
      notAfterMs: Date.now() + 30 * DAY_MS,
      extensions: [
        ext("551d13", seq(), true), // basicConstraints: not a CA
        ext("551d0f", Buffer.from("03020780", "hex"), true), // digitalSignature
        ext("551d25", seq(oid("2b06010505070301")), false), // serverAuth
        sanExt(host),
      ],
    });
    const leaf = { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert };
    this.leaves.set(host, leaf);
    return leaf;
  }

  /** Drop the CA private key; later `issue` calls for new hosts throw. */
  destroy(): void {
    this.signer = undefined;
    this.leaves.clear();
  }
}
