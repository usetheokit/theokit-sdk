import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";

import type { ModelSelection } from "../types/agent-prims.js";

/** One request body the fake server received. */
export interface FakeModelRequest {
  readonly model?: string;
  readonly stream?: boolean;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
  readonly tools?: unknown;
  /**
   * Set only on a request whose body was not valid JSON (answered with HTTP 400): `messages` is
   * empty and `error` says why.
   */
  readonly error?: string;
}

/** A running fake model server; see {@link startFakeModelServer}. */
export interface FakeModelServer {
  /** Pass as the agent's model: `{ id, url }` pointing at this server. */
  readonly model: ModelSelection;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Every request body received, in arrival order. */
  readonly requests: readonly FakeModelRequest[];
  close(): Promise<void>;
}

/** Options for {@link startFakeModelServer}. */
export interface FakeModelServerOptions {
  /** `"openai"`: `POST /v1/chat/completions` as SSE. `"ollama"`: `POST /api/chat` as NDJSON. Default `"openai"`. */
  wire?: "openai" | "ollama";
  /** The scripted answer, or a function of the request. Default `"ok"`. */
  reply?: string | ((request: FakeModelRequest) => string);
  /** Loopback address only. Default `"127.0.0.1"`. */
  host?: string;
}

// Scripted tool calls are not supported yet.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || (isIP(host) === 4 && host.startsWith("127."));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseRequest(raw: string): FakeModelRequest | { error: string } {
  try {
    const body: unknown = JSON.parse(raw);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { error: "request body is not a JSON object" };
    }
    const b = body as Record<string, unknown>;
    return {
      model: typeof b.model === "string" ? b.model : undefined,
      stream: typeof b.stream === "boolean" ? b.stream : undefined,
      messages: Array.isArray(b.messages) ? (b.messages as FakeModelRequest["messages"]) : [],
      tools: b.tools,
    };
  } catch (e) {
    return { error: `invalid JSON: ${(e as Error).message}` };
  }
}

function writeOpenAi(res: ServerResponse, model: string, text: string, stream: boolean): void {
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta: unknown, finish: string | null, extra?: object) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  res.write(frame({ role: "assistant", content: "" }, null));
  res.write(frame({ content: text }, null));
  res.write(
    frame({}, "stop", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  );
  res.end("data: [DONE]\n\n");
}

function writeOllama(res: ServerResponse, model: string, text: string): void {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const at = "1970-01-01T00:00:00Z";
  res.write(
    `${JSON.stringify({ model, created_at: at, message: { role: "assistant", content: text }, done: false })}\n`,
  );
  res.end(
    `${JSON.stringify({
      model,
      created_at: at,
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 1,
      eval_count: 1,
    })}\n`,
  );
}

function resolveReply(reply: FakeModelServerOptions["reply"], request: FakeModelRequest): string {
  if (typeof reply === "function") return reply(request);
  return reply ?? "ok";
}

/**
 * Start a local server that speaks a provider's chat wire protocol and answers with scripted text,
 * so an agent can run end to end with no credential and no real model.
 *
 * Listens on an OS-assigned port, on loopback only.
 *
 * @example
 * const server = await startFakeModelServer({ reply: "hello" });
 * const agent = await Agent.create({ model: server.model, local: { cwd } });
 * // ...
 * await server.close();
 */
export async function startFakeModelServer(
  options: FakeModelServerOptions = {},
): Promise<FakeModelServer> {
  const wire = options.wire ?? "openai";
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) {
    throw new Error(`startFakeModelServer: host must be a loopback address, got "${host}"`);
  }
  const path = wire === "openai" ? "/v1/chat/completions" : "/api/chat";
  const requests: FakeModelRequest[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `not found: ${req.method} ${req.url}` }));
      return;
    }
    const parsed = parseRequest(await readBody(req));
    if ("error" in parsed) {
      requests.push({ messages: [], error: parsed.error });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: parsed.error }));
      return;
    }
    requests.push(parsed);
    const text = resolveReply(options.reply, parsed);
    const model = parsed.model ?? "fake";
    if (wire === "openai") writeOpenAi(res, model, text, parsed.stream === true);
    else writeOllama(res, model, text);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const id = wire === "openai" ? "lmstudio/fake-model" : "ollama/fake-model";

  return {
    model: { id, url },
    url,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
