import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { createMcpClient } from "../../src/internal/mcp/client.js";

/** Stdio server: answers `initialize` with ANSWER, and echoes the initialize params in tools/list. */
const SERVER = `
let buf = "";
let init;
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    let result = {};
    if (m.method === "initialize") { init = m.params; result = { protocolVersion: process.env.ANSWER }; }
    if (m.method === "tools/list") result = { tools: [{ name: JSON.stringify(init), description: "", inputSchema: {} }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

function stdio(answer: string, pin?: "2025-03-26") {
  return createMcpClient("v", {
    type: "stdio",
    command: "node",
    args: ["-e", SERVER],
    env: { ANSWER: answer },
    requestTimeoutMs: 4000,
    ...(pin === undefined ? {} : { protocolVersion: pin }),
  });
}

async function offered(answer: string, pin?: "2025-03-26") {
  const client = stdio(answer, pin);
  try {
    await client.initialize();
    const tools = await client.listTools();
    return JSON.parse(tools[0]?.name ?? "{}") as {
      protocolVersion: string;
      clientInfo: { version: string };
    };
  } finally {
    await client.close();
  }
}

describe("MCP protocol version negotiation", () => {
  it("mcp_initialize_offers_2025_06_18", async () => {
    const params = await offered("2025-06-18");
    expect(params.protocolVersion).toBe("2025-06-18");
    expect(params.clientInfo.version).toBe(packageJson.version);
  });

  it("mcp_accepts_an_older_supported_version", async () => {
    const client = stdio("2024-11-05");
    await client.initialize();
    expect(client.protocolVersion).toBe("2024-11-05");
    expect(await client.listTools()).toHaveLength(1);
    await client.close();
  });

  it("mcp_rejects_an_unsupported_version", async () => {
    const client = stdio("2099-01-01");
    await expect(client.initialize()).rejects.toMatchObject({
      code: "mcp_protocol_unsupported",
      message: expect.stringMatching(/2025-06-18.*2099-01-01|2099-01-01.*2025-06-18/),
    });
    expect(client.protocolVersion).toBeUndefined();
    await client.close();
  });

  it("mcp_config_pins_protocol_version", async () => {
    const params = await offered("2025-03-26", "2025-03-26");
    expect(params.protocolVersion).toBe("2025-03-26");
  });

  it("mcp_http_sends_protocol_version_header", async () => {
    const seen: Array<{ method: string; header: string | null }> = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      seen.push({
        method: body.method,
        header: new Headers(init.headers).get("mcp-protocol-version"),
      });
      const result =
        body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createMcpClient("h", { type: "http", url: "http://x.test/mcp" }, fetchImpl);
    await client.initialize();
    await client.listTools();
    expect(client.protocolVersion).toBe("2025-06-18");
    expect(seen).toEqual([
      { method: "initialize", header: null },
      { method: "tools/list", header: "2025-06-18" },
    ]);
  });

  it("keeps the negotiated version visible through the tool filter", async () => {
    const client = createMcpClient("f", {
      type: "stdio",
      command: "node",
      args: ["-e", SERVER],
      env: { ANSWER: "2025-03-26" },
      requestTimeoutMs: 4000,
      tools: { exclude: ["x"] },
    });
    await client.initialize();
    expect(client.protocolVersion).toBe("2025-03-26");
    await client.close();
  });
});
