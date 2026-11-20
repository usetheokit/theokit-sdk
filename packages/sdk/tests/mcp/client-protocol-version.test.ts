import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient, type McpClient } from "../../src/internal/mcp/client.js";
import { NetworkError } from "../../src/errors.js";
import pkg from "../../package.json" with { type: "json" };

const opened: McpClient[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A stdio server that answers `initialize` with `answer`, echoes the params to stderr-free file. */
function stdioScript(answer: string): string {
  return `
    const fs = require("node:fs");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\\n")) !== -1) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.method === "initialize") {
          fs.writeFileSync(process.env.SEEN, JSON.stringify(m.params));
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: ${JSON.stringify(answer)} } }) + "\\n");
        } else if (m.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "t", description: "", inputSchema: {} }] } }) + "\\n");
        }
      }
    });
  `;
}

async function stdioClient(answer: string, extra: Record<string, unknown> = {}) {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const seenFile = join(mkdtempSync(join(tmpdir(), "mcp-pv-")), "seen.json");
  const client = createMcpClient("fake", {
    command: process.execPath,
    args: ["-e", stdioScript(answer)],
    env: { SEEN: seenFile },
    ...extra,
  });
  opened.push(client);
  return { client, seen: () => JSON.parse(readFileSync(seenFile, "utf8")) as Record<string, any> };
}

describe("mcp protocol version negotiation", () => {
  it("mcp_initialize_offers_2025_06_18", async () => {
    const { client, seen } = await stdioClient("2025-06-18");
    await client.initialize();
    expect(seen().protocolVersion).toBe("2025-06-18");
    expect(seen().clientInfo.version).toBe(pkg.version);
    expect(client.protocolVersion).toBe("2025-06-18");
  });

  it("mcp_accepts_an_older_supported_version", async () => {
    const { client } = await stdioClient("2024-11-05");
    await client.initialize();
    expect(client.protocolVersion).toBe("2024-11-05");
    expect(await client.listTools()).toHaveLength(1);
  });

  it("mcp_rejects_an_unsupported_version", async () => {
    const { client } = await stdioClient("2099-01-01");
    const err = await client.initialize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).code).toBe("mcp_protocol_unsupported");
    expect((err as Error).message).toContain("2025-06-18");
    expect((err as Error).message).toContain("2099-01-01");
    expect(client.protocolVersion).toBeUndefined();
  });

  it("mcp_config_pins_protocol_version", async () => {
    const { client, seen } = await stdioClient("2025-03-26", { protocolVersion: "2025-03-26" });
    await client.initialize();
    expect(seen().protocolVersion).toBe("2025-03-26");
    expect(client.protocolVersion).toBe("2025-03-26");
  });

  it("mcp_http_sends_protocol_version_header", async () => {
    const seen: Array<{ method: string; header: string | undefined }> = [];
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        const m = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
          id: number;
          method: string;
        };
        seen.push({
          method: m.method,
          header: req.headers["mcp-protocol-version"] as string | undefined,
        });
        const result =
          m.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [] };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const client = createMcpClient("http", { type: "http", url });
    await client.initialize();
    await client.listTools();
    expect(seen[0]?.header).toBeUndefined();
    expect(seen.find((s) => s.method === "tools/list")?.header).toBe("2025-06-18");
  });
});
