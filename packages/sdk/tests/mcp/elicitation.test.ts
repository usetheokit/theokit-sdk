import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import { createMcpClient, type McpClient } from "../../src/internal/mcp/client.js";
import type { McpElicitationHandler } from "../../src/types/mcp.js";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

/** Stdio server: on tools/call it sends a server request with ASK_ID and reports what it hears back. */
const STDIO = `
let buf = ""; let callId;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", echo: m.params } });
    else if (m.method === "tools/call") {
      callId = m.id;
      send({ jsonrpc: "2.0", id: process.env.ASK_ID === "same" ? m.id : 900, method: process.env.ASK_METHOD || "elicitation/create",
        params: { message: "ok?", requestedSchema: ${JSON.stringify(SCHEMA)} } });
    } else if (m.method === undefined && m.id !== undefined && callId !== undefined) {
      send({ jsonrpc: "2.0", id: callId, result: { content: [{ type: "text", text: JSON.stringify(m.result ?? m.error) }] } });
    }
  }
});
`;

const clients: McpClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setDiagnosticsSink(undefined);
});

function stdio(handler?: McpElicitationHandler, env: Record<string, string> = {}) {
  const c = createMcpClient(
    "s",
    { type: "stdio", command: "node", args: ["-e", STDIO], env, requestTimeoutMs: 4000 },
    undefined,
    handler === undefined ? {} : { onElicitation: handler },
  );
  clients.push(c);
  return c;
}

const accept: McpElicitationHandler = async () => ({ action: "accept", content: { ok: true } });

describe("MCP elicitation", () => {
  it("mcp_stdio_answers_elicitation", async () => {
    const c = stdio(accept);
    await c.initialize();
    const r = await c.callTool("t", {});
    expect(JSON.parse(r.content[0]?.text ?? "")).toEqual({
      action: "accept",
      content: { ok: true },
    });
  });

  it("mcp_server_request_id_never_resolves_a_client_request", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const c = stdio(
      async () => {
        await gate;
        return { action: "decline" };
      },
      { ASK_ID: "same" },
    );
    await c.initialize();
    let settled = false;
    const p = c.callTool("t", {}).then((x) => {
      settled = true;
      return x;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    const r = await p;
    expect(JSON.parse(r.content[0]?.text ?? "")).toEqual({ action: "decline" });
  });

  it("mcp_declares_elicitation_only_with_a_handler", async () => {
    const probe = async (handler?: McpElicitationHandler) => {
      const c = createMcpClient(
        "p",
        {
          type: "stdio",
          command: "node",
          args: [
            "-e",
            `process.stdin.once("data",d=>{const m=JSON.parse(d);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18"}})+"\\n");process.stdin.on("data",e=>{const n=JSON.parse(String(e).trim().split("\\n").pop());process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:n.id,result:{tools:[{name:JSON.stringify(m.params.capabilities),description:"",inputSchema:{}}]}})+"\\n")})})`,
          ],
          requestTimeoutMs: 4000,
        },
        undefined,
        handler === undefined ? {} : { onElicitation: handler },
      );
      clients.push(c);
      await c.initialize();
      return JSON.parse((await c.listTools())[0]?.name ?? "{}");
    };
    expect(await probe(accept)).toEqual({ tools: {}, elicitation: {} });
    expect(await probe()).toEqual({ tools: {} });
  });

  it("mcp_elicitation_without_handler_is_method_not_found", async () => {
    const c = stdio();
    await c.initialize();
    const r = await c.callTool("t", {});
    expect(JSON.parse(r.content[0]?.text ?? "").code).toBe(-32601);
  });

  it("mcp_other_server_methods_are_method_not_found", async () => {
    const c = stdio(accept, { ASK_METHOD: "sampling/createMessage" });
    await c.initialize();
    const r = await c.callTool("t", {});
    expect(JSON.parse(r.content[0]?.text ?? "").code).toBe(-32601);
  });

  it("mcp_elicitation_content_must_match_schema", async () => {
    const seen: string[] = [];
    setDiagnosticsSink((m) => seen.push(m));
    const c = stdio(async () => ({ action: "accept", content: {} }));
    await c.initialize();
    const r = await c.callTool("t", {});
    expect(JSON.parse(r.content[0]?.text ?? "")).toEqual({ action: "cancel" });
    expect(seen.join("")).toContain("mcp_elicitation_invalid");
    expect(seen.join("")).toContain("ConfigurationError");
  });

  it("a throwing handler answers cancel and is reported", async () => {
    const seen: string[] = [];
    setDiagnosticsSink((m) => seen.push(m));
    const c = stdio(async () => {
      throw new Error("boom");
    });
    await c.initialize();
    const r = await c.callTool("t", {});
    expect(JSON.parse(r.content[0]?.text ?? "")).toEqual({ action: "cancel" });
    expect(seen.join("")).toContain("boom");
  });
});

describe("MCP elicitation over Streamable HTTP", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server?.closeAllConnections();
  });

  it("mcp_http_answers_elicitation_on_the_event_stream", async () => {
    const sessions: (string | undefined)[] = [];
    let onAnswer: (body: { result?: unknown }) => void = () => undefined;
    const answered = new Promise<{ result?: unknown }>((r) => {
      onAnswer = r;
    });
    type Msg = { id?: number | string; method?: string; result?: unknown };
    const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const toolCall = (res: ServerResponse, m: Msg) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const params = { message: "ok?", requestedSchema: SCHEMA };
      res.write(sse({ jsonrpc: "2.0", id: "srv-1", method: "elicitation/create", params }));
      // The reply is withheld until the client has POSTed its answer on a second connection.
      void answered.then((body) => {
        const text = JSON.stringify(body.result);
        res.write(sse({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } }));
        res.end();
      });
    };
    const handle = (req: IncomingMessage, res: ServerResponse, m: Msg) => {
      if (m.method === "initialize") {
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "sess");
        const result = { protocolVersion: "2025-06-18" };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      } else if (m.method === "tools/call") toolCall(res, m);
      else if (m.id === "srv-1") {
        sessions.push(req.headers["mcp-session-id"] as string | undefined);
        res.statusCode = 202;
        res.end();
        onAnswer(m);
      } else res.end();
    };
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => {
        raw += d;
      });
      req.on("end", () => handle(req, res, JSON.parse(raw) as Msg));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const c = createMcpClient("h", { type: "http", url, requestTimeoutMs: 4000 }, undefined, {
      onElicitation: accept,
    });
    await c.initialize();
    const r = await c.callTool("t", {});
    expect(JSON.parse(r.content[0]?.text ?? "")).toEqual({
      action: "accept",
      content: { ok: true },
    });
    expect(sessions).toEqual(["sess"]);
  });
});
