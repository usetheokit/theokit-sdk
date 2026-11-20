/**
 * End-to-end encrypted, sender-authenticated A2A messages (#1051).
 *
 * `sealedTransport` wraps an {@link A2ATransport}. Each message is sealed to one trusted peer with
 * X25519 (ephemeral and static keys), HKDF-SHA256 and AES-256-GCM, and the inner transport carries
 * only public keys, a sequence number and ciphertext. On receipt the sender is identified by its
 * public key, which must be in `trustedPeers`; `from` is then the trusted NAME, not a claim.
 *
 * Scope: one identity is one agent. Everything polled for any agent id is read from the queue
 * addressed to this identity's public key. Key distribution is out of scope.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { TheokitAgentError } from "../errors.js";
import { diag } from "../internal/diagnostics.js";
import { replaceFileAtomic } from "../internal/persistence/atomic-write.js";
import type { A2ATransport } from "./transport.js";
import type { A2AMessage } from "./types.js";

const LABEL = "theokit-a2a-v1";
const SEALED_TYPE = "theokit-a2a-sealed";
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * An X25519 identity as base64url raw 32-byte keys.
 *
 * @experimental
 * @public
 */
export interface A2AIdentity {
  publicKey: string;
  privateKey: string;
}

/**
 * Trusted peers: name to base64url raw X25519 public key.
 *
 * @experimental
 * @public
 */
export type TrustedPeers = ReadonlyMap<string, string>;

/**
 * Per-peer sequence counters. `acceptReceived` returns false when `seq` is not above the last
 * accepted one (replay).
 *
 * @experimental
 * @public
 */
export interface SequenceStore {
  nextSent(peerKey: string): Promise<number>;
  acceptReceived(peerKey: string, seq: number): Promise<boolean>;
}

/**
 * Sealing to a peer name that is not in `trustedPeers`.
 *
 * @experimental
 * @public
 */
export class A2AUntrustedPeerError extends TheokitAgentError {
  override readonly name = "A2AUntrustedPeerError";
  override readonly code = "a2a_untrusted_peer" as const;

  constructor(
    /** The peer name that is not trusted. */
    public readonly peer: string,
  ) {
    super(`a2a: peer "${peer}" is not in trustedPeers`, {
      code: "a2a_untrusted_peer",
      isRetryable: false,
    });
  }
}

/**
 * Why an inbound sealed message was dropped.
 *
 * @experimental
 * @public
 */
export type SealedDropReason =
  | "malformed"
  | "wrong_recipient"
  | "untrusted_peer"
  | "authentication_failed"
  | "replay";

class DropError extends Error {
  constructor(readonly reason: SealedDropReason) {
    super(reason);
  }
}

interface Envelope {
  v: string;
  sender: string;
  recipient: string;
  eph: string;
  seq: number;
  nonce: string;
  ct: string;
}

/**
 * Generates a fresh X25519 identity.
 *
 * @experimental
 * @public
 */
export function generateA2AIdentity(): A2AIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: Buffer.from(publicKey.export({ format: "der", type: "spki" }))
      .subarray(SPKI_PREFIX.length)
      .toString("base64url"),
    privateKey: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }))
      .subarray(PKCS8_PREFIX.length)
      .toString("base64url"),
  };
}

function rawKey(value: string): Buffer {
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== 32) throw new DropError("malformed");
  return raw;
}

function publicKeyObject(value: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, rawKey(value)]),
    format: "der",
    type: "spki",
  });
}

function privateKeyObject(value: string): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, rawKey(value)]),
    format: "der",
    type: "pkcs8",
  });
}

function deriveKey(args: {
  dh1: Buffer;
  dh2: Buffer;
  sender: string;
  recipient: string;
  eph: string;
}): Buffer {
  const { dh1, dh2, sender, recipient, eph } = args;
  const info = Buffer.from(`${LABEL}|key|${sender}|${recipient}|${eph}`);
  return Buffer.from(hkdfSync("sha256", Buffer.concat([dh1, dh2]), Buffer.alloc(0), info, 32));
}

function aadFor(sender: string, recipient: string, eph: string, seq: number): Buffer {
  return Buffer.from(`${LABEL}|aad|${sender}|${recipient}|${eph}|${seq}`);
}

function seal(identity: A2AIdentity, peerKey: string, seq: number, plaintext: Buffer): Envelope {
  const eph = generateA2AIdentity();
  const peerPub = publicKeyObject(peerKey);
  const key = deriveKey({
    dh1: diffieHellman({ privateKey: privateKeyObject(eph.privateKey), publicKey: peerPub }),
    dh2: diffieHellman({ privateKey: privateKeyObject(identity.privateKey), publicKey: peerPub }),
    sender: identity.publicKey,
    recipient: peerKey,
    eph: eph.publicKey,
  });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(identity.publicKey, peerKey, eph.publicKey, seq));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    v: LABEL,
    sender: identity.publicKey,
    recipient: peerKey,
    eph: eph.publicKey,
    seq,
    nonce: nonce.toString("base64url"),
    ct: ct.toString("base64url"),
  };
}

function open(identity: A2AIdentity, env: Envelope): Buffer {
  try {
    const own = privateKeyObject(identity.privateKey);
    const key = deriveKey({
      dh1: diffieHellman({ privateKey: own, publicKey: publicKeyObject(env.eph) }),
      dh2: diffieHellman({ privateKey: own, publicKey: publicKeyObject(env.sender) }),
      sender: env.sender,
      recipient: env.recipient,
      eph: env.eph,
    });
    const ct = Buffer.from(env.ct, "base64url");
    const nonce = Buffer.from(env.nonce, "base64url");
    if (ct.length < 16 || nonce.length !== 12) throw new DropError("authentication_failed");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aadFor(env.sender, env.recipient, env.eph, env.seq));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  } catch (cause) {
    throw new DropError(cause instanceof DropError ? cause.reason : "authentication_failed");
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseEnvelope(message: A2AMessage): Envelope {
  const p = message.payload as Partial<Record<keyof Envelope, unknown>> | null;
  const ok =
    message.type === SEALED_TYPE &&
    typeof p === "object" &&
    p !== null &&
    p.v === LABEL &&
    [p.sender, p.recipient, p.eph, p.nonce, p.ct].every(isString) &&
    Number.isSafeInteger(p.seq);
  if (!ok) throw new DropError("malformed");
  return p as unknown as Envelope;
}

/** Serializes async operations so counters never interleave. */
function serializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

interface Counters {
  sent: Record<string, number>;
  received: Record<string, number>;
}

function counterStore(persist: (c: Counters) => Promise<void>, initial: Counters): SequenceStore {
  const counters = initial;
  const serial = serializer();
  return {
    nextSent: (peerKey) =>
      serial(async () => {
        const next = (counters.sent[peerKey] ?? 0) + 1;
        const before = counters.sent[peerKey];
        counters.sent[peerKey] = next;
        try {
          await persist(counters);
        } catch (cause) {
          if (before === undefined) delete counters.sent[peerKey];
          else counters.sent[peerKey] = before;
          throw cause;
        }
        return next;
      }),
    acceptReceived: (peerKey, seq) =>
      serial(async () => {
        const last = counters.received[peerKey] ?? 0;
        if (!Number.isSafeInteger(seq) || seq <= last) return false;
        counters.received[peerKey] = seq;
        try {
          await persist(counters);
        } catch (cause) {
          counters.received[peerKey] = last;
          throw cause;
        }
        return true;
      }),
  };
}

/**
 * Sequence counters held in memory only.
 *
 * @experimental
 * @public
 */
export function memorySequenceStore(): SequenceStore {
  return counterStore(async () => undefined, { sent: {}, received: {} });
}

function loadCounters(file: string): Counters {
  const counters: Counters = { sent: {}, received: {} };
  if (!existsSync(file)) return counters;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Counters> | null;
  for (const kind of ["sent", "received"] as const) {
    const source = parsed?.[kind];
    if (typeof source !== "object" || source === null) continue;
    for (const [k, v] of Object.entries(source)) {
      if (Number.isSafeInteger(v)) counters[kind][k] = v;
    }
  }
  return counters;
}

/**
 * Sequence counters persisted to a JSON file (atomic write, mode 0600). Operations are serialized
 * within one instance; separate processes sharing one file are not coordinated.
 *
 * @experimental
 * @public
 */
export function jsonSequenceStore(file: string): SequenceStore {
  return counterStore(
    (c) => replaceFileAtomic(file, JSON.stringify(c), { mode: 0o600 }),
    loadCounters(file),
  );
}

interface Opened {
  type: string;
  payload: unknown;
  timestamp: number;
  origin?: unknown;
}

async function openMessage(
  ctx: { identity: A2AIdentity; names: Map<string, string>; sequences: SequenceStore },
  agentId: string,
  message: A2AMessage,
): Promise<A2AMessage> {
  const { identity, names, sequences } = ctx;
  const env = parseEnvelope(message);
  if (env.recipient !== identity.publicKey) throw new DropError("wrong_recipient");
  const name = names.get(env.sender);
  if (name === undefined) throw new DropError("untrusted_peer");
  const inner = JSON.parse(open(identity, env).toString("utf8")) as Opened;
  // Only after the tag verified: an unauthenticated message must not advance the counter.
  if (!(await sequences.acceptReceived(env.sender, env.seq))) throw new DropError("replay");
  return {
    type: inner.type,
    payload: inner.payload,
    from: name,
    to: agentId,
    timestamp: inner.timestamp,
    origin: { kind: "peer", from: name },
  };
}

/**
 * Wraps `inner` so messages are end-to-end encrypted to, and authenticated as from, trusted peers.
 * The bus's `to` is the trusted peer NAME on send; on poll `from` is the trusted name. A message
 * that fails to open, comes from an untrusted key or replays a sequence is dropped and reported on
 * diagnostics with its reason (never the plaintext). Sequence numbers must rise, so out-of-order
 * delivery drops the older message; keep `sequences` persistent across restarts.
 *
 * @experimental
 * @public
 */
export function sealedTransport(
  inner: A2ATransport,
  options: { identity: A2AIdentity; trustedPeers: TrustedPeers; sequences?: SequenceStore },
): A2ATransport {
  const { identity, trustedPeers } = options;
  const sequences = options.sequences ?? memorySequenceStore();
  const names = new Map<string, string>();
  for (const [name, key] of trustedPeers) names.set(key, name);
  return {
    async send(message) {
      const peerKey = trustedPeers.get(message.to);
      if (peerKey === undefined) throw new A2AUntrustedPeerError(message.to);
      const plaintext = Buffer.from(
        JSON.stringify({
          type: message.type,
          payload: message.payload,
          timestamp: message.timestamp,
        }),
      );
      const env = seal(identity, peerKey, await sequences.nextSent(peerKey), plaintext);
      await inner.send({
        type: SEALED_TYPE,
        payload: env,
        from: identity.publicKey,
        to: peerKey,
        timestamp: message.timestamp,
      });
    },
    async poll(agentId) {
      const out: A2AMessage[] = [];
      for (const message of await inner.poll(identity.publicKey)) {
        try {
          out.push(await openMessage({ identity, names, sequences }, agentId, message));
        } catch (cause) {
          const reason = cause instanceof DropError ? cause.reason : "malformed";
          diag(`[theokit-sdk] a2a: sealed message dropped (${reason})\n`);
        }
      }
      return out;
    },
  };
}
