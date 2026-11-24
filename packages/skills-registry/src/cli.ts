#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
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

function toRequest(req: IncomingMessage, host: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
  }
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
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}

function main(): void {
  let values: { dir?: string; port?: string; host?: string; help?: boolean };
  try {
    values = parseArgs({
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
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const token = process.env.SKILLS_REGISTRY_TOKEN ?? "";
  if (token.trim() === "") die("SKILLS_REGISTRY_TOKEN is not set or empty; refusing to start");
  const portText = values.port ?? "8787";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) die(`invalid --port "${portText}"`);
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

main();
