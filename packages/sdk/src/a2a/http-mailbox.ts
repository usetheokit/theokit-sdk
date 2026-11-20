/**
 * HTTP store-and-forward mailbox for A2A messages (#1050).
 *
 * `createHttpMailboxHandler` is a fetch-style server handler holding one bounded queue per
 * recipient; `httpMailboxTransport` is the {@link A2ATransport} client for it.
 *
 * Security limits, by design: ONE shared bearer token guards the whole mailbox, so any holder can
 * `take` ANY recipient's queue (draining another peer's messages), and `from` is self-asserted.
 * Neither is authenticated per peer here.
 */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { ConfigurationError, TheokitAgentError } from "../errors.js";
import { replaceFileAtomic } from "../internal/persistence/atomic-write.js";
import type { A2ATransport } from "./transport.js";
import type { A2AMessage } from "./types.js";

const DEFAULT_MAX_PER_RECIPIENT = 100;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/**
 * A mailbox request failed: a non-2xx HTTP answer (`status` set), or a refused persisted file.
 *
 * @public
 */
export class A2AMailboxError extends TheokitAgentError {
  override readonly name = "A2AMailboxError";
  override readonly code = "a2a_mailbox_error" as const;

  constructor(
    message: string,
    /** The HTTP status of the answer, when the error came from one. */
    public readonly status?: number,
    options: { cause?: unknown } = {},
  ) {
    super(message, {
      code: "a2a_mailbox_error",
      isRetryable: status === undefined || status >= 500,
      ...options,
    });
  }
}

/**
 * Options for {@link createHttpMailboxHandler}.
 *
 * @public
 */
export interface HttpMailboxOptions {
  /** Shared bearer token every request must carry. */
  token: string;
  /** Queue cap per recipient; a full queue answers 507. Default 100. */
  maxPerRecipient?: number;
  /** Request body cap in bytes; larger answers 413. Default 256 KiB. */
  maxBodyBytes?: number;
  /** JSON file the queues persist to (atomic write, mode 0600). */
  persistPath?: string;
}

type Queues = Map<string, A2AMessage[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is A2AMessage {
  if (!isRecord(value)) return false;
  if (typeof value.type !== "string" || typeof value.from !== "string") return false;
  if (typeof value.to !== "string" || value.to.length === 0) return false;
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
  if (!("payload" in value)) return false;
  const origin = value.origin;
  return origin === undefined || (isRecord(origin) && typeof origin.kind === "string");
}

function loadQueues(path: string): Queues {
  const queues: Queues = new Map();
  if (!existsSync(path)) return queues;
  const refuse = (why: string, cause?: unknown): never => {
    throw new A2AMailboxError(`Mailbox file ${path} is not valid: ${why}`, undefined, { cause });
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return refuse("unreadable or not JSON", cause);
  }
  if (!isRecord(parsed)) return refuse("expected an object of recipient queues");
  for (const [recipient, list] of Object.entries(parsed)) {
    if (!Array.isArray(list) || !list.every((m) => isMessage(m) && m.to === recipient)) {
      return refuse(`bad queue for "${recipient}"`);
    }
    if (list.length > 0) queues.set(recipient, list as A2AMessage[]);
  }
  return queues;
}

async function persist(path: string, queues: Queues): Promise<void> {
  await replaceFileAtomic(path, JSON.stringify(Object.fromEntries(queues)), { mode: 0o600 });
}

function tokenMatches(header: string | null, token: string): boolean {
  const prefix = "Bearer ";
  if (header === null || !header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  // timingSafeEqual needs equal lengths; compare against self on a length miss to keep the work flat.
  const lengthOk = given.length === expected.length;
  return timingSafeEqual(lengthOk ? given : expected, expected) && lengthOk;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

class BodyTooLargeError extends Error {}

async function readBody(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseBody(request: Request, max: number): Promise<unknown | Response> {
  let text: string;
  try {
    text = await readBody(request, max);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json(413, { error: "body too large" });
    return json(400, { error: "unreadable body" });
  }
  try {
    return JSON.parse(text);
  } catch {
    return json(400, { error: "invalid JSON" });
  }
}

/**
 * Build a fetch-style handler serving `POST <prefix>/put` and `POST <prefix>/take`. Mount it under
 * any path prefix. A persisted file that fails its shape check throws {@link A2AMailboxError} here
 * and is left untouched.
 *
 * Every holder of the shared token can take any recipient's queue.
 *
 * @public
 */
export function createHttpMailboxHandler(
  options: HttpMailboxOptions,
): (request: Request) => Promise<Response> {
  const maxPer = options.maxPerRecipient ?? DEFAULT_MAX_PER_RECIPIENT;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const queues = options.persistPath ? loadQueues(options.persistPath) : new Map();
  let chain: Promise<unknown> = Promise.resolve();

  // Mutations run one at a time; state is committed only after the file write succeeded.
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const commit = async (recipient: string, next: A2AMessage[]): Promise<void> => {
    const copy: Queues = new Map(queues);
    if (next.length > 0) copy.set(recipient, next);
    else copy.delete(recipient);
    if (options.persistPath) await persist(options.persistPath, copy);
    if (next.length > 0) queues.set(recipient, next);
    else queues.delete(recipient);
  };

  const put = (body: unknown): Promise<Response> => {
    const message = isRecord(body) ? body.message : undefined;
    if (!isMessage(message)) return Promise.resolve(json(400, { error: "invalid message" }));
    return mutate(async () => {
      const current = queues.get(message.to) ?? [];
      if (current.length >= maxPer) return json(507, { error: "mailbox full" });
      await commit(message.to, [...current, message]);
      return json(200, { ok: true });
    });
  };

  const take = (body: unknown): Promise<Response> => {
    const recipient = isRecord(body) ? body.recipient : undefined;
    if (typeof recipient !== "string" || recipient.length === 0) {
      return Promise.resolve(json(400, { error: "invalid recipient" }));
    }
    return mutate(async () => {
      const envelopes = queues.get(recipient) ?? [];
      if (envelopes.length > 0) await commit(recipient, []);
      return json(200, { envelopes });
    });
  };

  const dispatch = async (request: Request, route: "put" | "take"): Promise<Response> => {
    const body = await parseBody(request, maxBody);
    if (body instanceof Response) return body;
    try {
      return await (route === "put" ? put(body) : take(body));
    } catch {
      return json(500, { error: "mailbox storage failed" });
    }
  };

  return async (request) => {
    const rejected = preflight(request, options.token);
    if (rejected) return rejected;
    const route = new URL(request.url).pathname.replace(/\/+$/, "").split("/").pop();
    if (route !== "put" && route !== "take") return json(404, { error: "not found" });
    return dispatch(request, route);
  };
}

/** Method and bearer checks: they run before anything reads the body. */
function preflight(request: Request, token: string): Response | undefined {
  if (request.method !== "POST") {
    return json(405, { error: "method not allowed" }, { allow: "POST" });
  }
  if (!tokenMatches(request.headers.get("authorization"), token)) {
    return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }
  return undefined;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkBaseUrl(baseUrl: string): URL {
  const insecure = (why: string): ConfigurationError =>
    new ConfigurationError(`Mailbox baseUrl refused: ${why}`, { code: "a2a_mailbox_insecure_url" });
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw insecure("not a valid URL");
  }
  if (url.username || url.password) throw insecure("credentials in the URL");
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback)
    throw insecure("use https:, or http: only on localhost, 127.0.0.1 or [::1]");
  return url;
}

/**
 * An {@link A2ATransport} over an HTTP mailbox served by {@link createHttpMailboxHandler}.
 * A non-2xx answer rejects with {@link A2AMailboxError} carrying the status. `baseUrl` must be
 * `https:`, or `http:` on the loopback only (`ConfigurationError`, `a2a_mailbox_insecure_url`).
 *
 * @public
 */
export function httpMailboxTransport(options: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): A2ATransport {
  const base = checkBaseUrl(options.baseUrl).href.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const call = async (route: "put" | "take", body: unknown): Promise<unknown> => {
    const response = await doFetch(`${base}/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new A2AMailboxError(
        `Mailbox ${route} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return response.json();
  };
  return {
    async send(message) {
      await call("put", { message });
    },
    async poll(agentId) {
      const answer = await call("take", { recipient: agentId });
      const envelopes = isRecord(answer) ? answer.envelopes : undefined;
      if (!Array.isArray(envelopes) || !envelopes.every(isMessage)) {
        throw new A2AMailboxError("Mailbox take answered with a malformed body", 200);
      }
      return envelopes;
    },
  };
}
