/**
 * Published as `@theokit/sdk/mcp-events`.
 *
 * Subscribe to events from an MCP server that implements the events profile (`events/subscribe`,
 * Streamable HTTP). The client starts a local HTTP receiver, sends `events/subscribe` with a
 * per-subscription HMAC secret and the callback URL, and hands every authenticated delivery to
 * `onEvent` together with its subscription id. A delivery whose signature does not match is
 * answered 401 and never reaches the callback.
 *
 * Wire format (assumed from the profile as OpenClaw uses it): the server POSTs a JSON body
 * `{ subscriptionId, ...event }` to the callback URL with header `x-mcp-signature: sha256=<hex>`,
 * the HMAC-SHA256 of the raw body keyed by the secret sent in `events/subscribe`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NetworkError } from "./errors.js";
import { createMcpClient, type McpClient } from "./internal/mcp/client.js";
import type { McpHttpServerConfig } from "./types/mcp.js";

/** Header carrying the delivery signature. */
export const MCP_EVENT_SIGNATURE_HEADER = "x-mcp-signature";

const MAX_BODY_BYTES = 1024 * 1024;

/** One authenticated event delivery. */
export interface McpEventDelivery {
  /** Id of the subscription the server delivered this event for. */
  subscriptionId: string;
  /** The parsed JSON body of the delivery, payload intact. */
  event: Record<string, unknown>;
}

/** Signature header value (`sha256=<hex>`) for `body`. */
export function signMcpEvent(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time check of a signature header against the body. */
export function verifyMcpEventSignature(
  secret: string,
  body: string | Buffer,
  signature: string | undefined,
): boolean {
  if (signature === undefined) return false;
  const expected = Buffer.from(signMcpEvent(secret, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Options for `createMcpEventSubscriber`. */
export interface McpEventSubscriberOptions {
  /** The MCP server (Streamable HTTP). */
  server: McpHttpServerConfig;
  /** Name used in errors. Default `"mcp-events"`. */
  name?: string;
  /**
   * Public origin the MCP server can reach the receiver at (e.g. `https://hooks.example.com`).
   * Default: `http://127.0.0.1:<port>`.
   */
  callbackOrigin?: string;
  /** Interface the receiver binds to. Default `127.0.0.1`. */
  host?: string;
  /** Port the receiver binds to. Default 0 (ephemeral). */
  port?: number;
  /** Injected fetch for the MCP transport. */
  fetch?: typeof fetch;
}

/** Options for `McpEventSubscriber.subscribe`. */
export interface McpEventSubscribeOptions {
  /** Event types to subscribe to; omitted = the server's default. */
  events?: string[];
  /** Called for each authenticated delivery. */
  onEvent: (delivery: McpEventDelivery) => void | Promise<void>;
}

/** A live subscription; call `unsubscribe()` to stop receiving deliveries. */
export interface McpEventSubscription {
  subscriptionId: string;
  unsubscribe(): Promise<void>;
}

interface Registered {
  secret: string;
  subscriptionId: string | undefined;
  onEvent: McpEventSubscribeOptions["onEvent"];
}

function parseDelivery(body: Buffer, entry: Registered): McpEventDelivery | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const event = parsed as Record<string, unknown>;
  const id = event.subscriptionId;
  // The delivery must name the subscription it belongs to, and it must be ours.
  if (typeof id !== "string" || id !== entry.subscriptionId) return undefined;
  return { subscriptionId: id, event };
}

function handleBody(body: Buffer, req: IncomingMessage, res: ServerResponse, entry: Registered) {
  const header = req.headers[MCP_EVENT_SIGNATURE_HEADER];
  if (
    !verifyMcpEventSignature(entry.secret, body, typeof header === "string" ? header : undefined)
  ) {
    res.writeHead(401).end();
    return;
  }
  const delivery = parseDelivery(body, entry);
  if (delivery === undefined) {
    res.writeHead(400).end();
    return;
  }
  res.writeHead(204).end();
  Promise.resolve(entry.onEvent(delivery)).catch(() => undefined);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

/** Subscribes to events from one MCP server through a local signed-delivery receiver. */
export class McpEventSubscriber {
  private readonly client: McpClient;
  private readonly registry = new Map<string, Registered>();
  private httpServer: Server | undefined;
  private origin = "";
  private ready = false;

  constructor(private readonly options: McpEventSubscriberOptions) {
    this.client = createMcpClient(options.name ?? "mcp-events", options.server, options.fetch);
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const message = (await this.client.call?.(method, params)) as
      | { result?: unknown; error?: { message?: string } }
      | undefined;
    if (message?.error !== undefined) {
      throw new NetworkError(`MCP ${method} failed: ${message.error.message ?? "error"}`, {
        code: "mcp_http_error",
      });
    }
    return message?.result;
  }

  private async start(): Promise<void> {
    if (this.ready) return;
    const server = createServer((req, res) => this.receive(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", resolve);
    });
    this.httpServer = server;
    const { port } = server.address() as AddressInfo;
    this.origin = trimTrailingSlashes(this.options.callbackOrigin ?? `http://127.0.0.1:${port}`);
    await this.client.initialize();
    this.ready = true;
  }

  private receive(req: IncomingMessage, res: ServerResponse): void {
    const token = (req.url ?? "").split("?")[0]?.split("/").pop() ?? "";
    const entry = this.registry.get(token);
    if (req.method !== "POST" || entry === undefined) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size <= MAX_BODY_BYTES) handleBody(Buffer.concat(chunks), req, res, entry);
    });
  }

  async subscribe(options: McpEventSubscribeOptions): Promise<McpEventSubscription> {
    await this.start();
    const token = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const entry: Registered = { secret, subscriptionId: undefined, onEvent: options.onEvent };
    this.registry.set(token, entry);
    try {
      const result = (await this.rpc("events/subscribe", {
        callbackUrl: `${this.origin}/mcp-events/${token}`,
        secret,
        ...(options.events !== undefined ? { events: options.events } : {}),
      })) as { subscriptionId?: unknown } | undefined;
      if (typeof result?.subscriptionId !== "string" || result.subscriptionId === "") {
        throw new NetworkError("MCP events/subscribe returned no subscriptionId", {
          code: "mcp_http_error",
        });
      }
      const subscriptionId = result.subscriptionId;
      entry.subscriptionId = subscriptionId;
      return {
        subscriptionId,
        unsubscribe: async () => {
          this.registry.delete(token);
          await this.rpc("events/unsubscribe", { subscriptionId });
        },
      };
    } catch (error) {
      this.registry.delete(token);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.registry.clear();
    const server = this.httpServer;
    this.httpServer = undefined;
    this.ready = false;
    await this.client.close();
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }
}

/** Create a subscriber for one MCP server. Call `close()` when done. */
export function createMcpEventSubscriber(options: McpEventSubscriberOptions): McpEventSubscriber {
  return new McpEventSubscriber(options);
}
