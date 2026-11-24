#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseArgs } from "node:util";
import { createSkillsRegistryHandler } from "./server.js";

const USAGE = `Usage: theokit-skills-registry [--dir <path>] [--port <n>] [--host <addr>]
  --dir   registry directory (default ./skills-registry)
  --port  port, 0 for any free port (default 8787)
  --host  address to bind (default 127.0.0.1)
The publish token is read from SKILLS_REGISTRY_TOKEN.
`;

function die(message: string): never {
  process.stderr.write(`theokit-skills-registry: ${message}\n`);
  process.exit(1);
}

function toHeaders(raw: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    for (const item of [v ?? []].flat()) headers.append(k, item);
  }
  return headers;
}

function toRequest(req: IncomingMessage, host: string): Request {
  const headers = toHeaders(req.headers);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = "half";
  }
  return new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? host}`), init);
}

async function send(res: ServerResponse, response: Response, head: boolean): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (head || response.body === null) {
    res.end();
    return;
  }
  // pipeline honours backpressure and stops reading when the client goes away
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res);
}

type Options = { dir?: string; port?: string; host?: string; help?: boolean };

function parseOptions(): Options {
  try {
    return parseArgs({
      options: {
        dir: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    return die(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
}

function readPort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65535) die(`invalid --port "${text}"`);
  return port;
}

function serve(values: Options, token: string): void {
  const port = readPort(values.port ?? "8787");
  const host = values.host ?? "127.0.0.1";
  const handler = createSkillsRegistryHandler({ dir: values.dir ?? "./skills-registry", token });
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await send(res, await handler(toRequest(req, host)), req.method === "HEAD");
      } catch {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"internal error"}');
      }
    })();
  });
  server.on("error", (error) => die(error.message));
  server.listen(port, host, () => {
    const a = server.address() as AddressInfo;
    process.stdout.write(`skills-registry listening on http://${a.address}:${a.port}\n`);
  });
}

function main(): void {
  const values = parseOptions();
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const token = process.env.SKILLS_REGISTRY_TOKEN ?? "";
  if (token.trim() === "") die("SKILLS_REGISTRY_TOKEN is not set or empty; refusing to start");
  serve(values, token);
}

main();
