/**
 * #1035 — per-server `tools.include` / `tools.exclude`: filtered at `tools/list`, refused at call
 * time before any request reaches the server, validated at `Agent.create`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, ConfigurationError } from "@theokit/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeCloudAgentConfig } from "../../src/internal/cloud-agent/cloud-config-serializer.js";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import { createMcpClient, type McpClient } from "../../src/internal/mcp/client.js";
import type { McpServerConfig } from "../../src/types/mcp.js";

const SERVER = `
const fs = require("node:fs");
const log = process.argv[2];
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === "tools/list") {
      result = { tools: ["a", "b", "danger"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })) };
    } else if (m.method === "tools/call") {
      fs.appendFileSync(log, m.params.name + "\\n");
      result = { content: [{ type: "text", text: "ran " + m.params.name }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

let dir: string;
let logFile: string;
let clients: McpClient[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-tool-filter-"));
  logFile = join(dir, "calls.log");
  writeFileSync(join(dir, "server.cjs"), SERVER);
  clients = [];
});
afterEach(async () => {
  setDiagnosticsSink(undefined);
  await Promise.all(clients.map((c) => c.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function connect(tools?: { include?: string[]; exclude?: string[] }): Promise<McpClient> {
  const config: McpServerConfig = {
    command: process.execPath,
    args: [join(dir, "server.cjs"), logFile],
    ...(tools ? { tools } : {}),
  };
  const client = createMcpClient("fixture", config);
  clients.push(client);
  await client.initialize();
  return client;
}

const names = async (c: McpClient) => (await c.listTools()).map((t) => t.name);

describe("mcp tool filter", () => {
  it("exclude offers the model a and b only", async () => {
    expect(await names(await connect({ exclude: ["danger"] }))).toEqual(["a", "b"]);
  });

  it("include offers only a", async () => {
    expect(await names(await connect({ include: ["a"] }))).toEqual(["a"]);
  });

  it("exclude applies after include", async () => {
    expect(await names(await connect({ include: ["a", "danger"], exclude: ["danger"] }))).toEqual([
      "a",
    ]);
  });

  it("no filter offers everything", async () => {
    expect(await names(await connect())).toEqual(["a", "b", "danger"]);
  });

  it("a forced call of a filtered tool is refused client-side, naming tool and server", async () => {
    const client = await connect({ exclude: ["danger"] });
    const result = await client.callTool("danger", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("danger");
    expect(result.content[0]?.text).toContain("fixture");
    const ok = await client.callTool("a", {});
    expect(ok.isError).toBeUndefined();
    const calls = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : [];
    expect(calls).toEqual(["a"]);
  });

  it("an include name the server does not list warns once, naming it", async () => {
    const messages: string[] = [];
    setDiagnosticsSink((m) => messages.push(m));
    await names(await connect({ include: ["a", "tpyo", "tpyo"] }));
    const warnings = messages.filter((m) => m.includes("tpyo"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("fixture");
  });
});

describe("mcp tool filter validation", () => {
  async function create(tools: unknown) {
    return Agent.create({
      apiKey: "theo_test_1035",
      model: { id: "composer-2" },
      local: { cwd: dir },
      mcpServers: { pw: { command: "node", tools } as unknown as McpServerConfig },
    });
  }

  it.each([
    [{ exclude: [""] }],
    [{ include: "a" }],
    [{ include: [1] }],
    ["x"],
    [{ exclude: new Array(1) }],
  ])("rejects %j with invalid_mcp_tool_filter naming the server", async (tools) => {
    const err = await create(tools).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).code).toBe("invalid_mcp_tool_filter");
    expect((err as ConfigurationError).message).toContain('"pw"');
  });
});

describe("mcp tool filter over http", () => {
  it("filters list and refuses calls without a request", async () => {
    const methods: string[] = [];
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        const m = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
          id?: number;
          method: string;
        };
        methods.push(m.method);
        const result =
          m.method === "tools/list"
            ? { tools: ["a", "danger"].map((name) => ({ name, inputSchema: { type: "object" } })) }
            : { content: [{ type: "text", text: "ok" }] };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const client = createMcpClient("web", { type: "http", url, tools: { exclude: ["danger"] } });
      expect((await client.listTools()).map((t) => t.name)).toEqual(["a"]);
      const r = await client.callTool("danger", {});
      expect(r.isError).toBe(true);
      expect(methods).not.toContain("tools/call");
      await client.close();
    } finally {
      server.close();
    }
  });
});

describe("mcp tool filter in the cloud payload", () => {
  it("is carried for http and stdio servers", () => {
    const tools = { exclude: ["danger"] };
    const payload = serializeCloudAgentConfig({
      apiKey: "k",
      model: { id: "composer-2" },
      cloud: { repos: [{ url: "https://github.com/o/r" }] },
      mcpServers: { h: { type: "http", url: "http://x", tools }, s: { command: "npx", tools } },
    });
    expect(payload.mcpServers?.h).toMatchObject({ tools });
    expect(payload.mcpServers?.s).toMatchObject({ tools });
  });
});
