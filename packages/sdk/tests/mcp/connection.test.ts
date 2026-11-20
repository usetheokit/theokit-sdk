import { describe, expect, it } from "vitest";
import { ConfigurationError, NetworkError } from "../../src/errors.js";
import { connectMcpServer } from "../../src/mcp.js";

/** Fake stdio server; CAPS (JSON) is its advertised capabilities. */
const SERVER = `
let buf = "";
const reply = (id, result, error) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id === undefined) continue;
    const p = m.params || {};
    if (m.method === "initialize") reply(m.id, { protocolVersion: "2025-06-18", capabilities: JSON.parse(process.env.CAPS) });
    else if (m.method === "resources/list") reply(m.id, p.cursor
      ? { resources: [{ uri: "file:///b", name: "b" }] }
      : { resources: [{ uri: "file:///a", name: "a" }], nextCursor: "2" });
    else if (m.method === "resources/read") p.uri === "bad"
      ? reply(m.id, null, { code: -32002, message: "no such resource" })
      : reply(m.id, { contents: [{ uri: p.uri, text: "hello" }] });
    else if (m.method === "prompts/list") reply(m.id, { prompts: [{ name: "greet", arguments: [{ name: "name", required: true }] }] });
    else if (m.method === "prompts/get") reply(m.id, { messages: [{ role: "user", content: { type: "text", text: "Hi " + p.arguments.name } }] });
    else reply(m.id, {});
  }
});
`;

const connect = (caps: object) =>
  connectMcpServer("fake", {
    type: "stdio",
    command: "node",
    args: ["-e", SERVER],
    env: { CAPS: JSON.stringify(caps) },
    requestTimeoutMs: 4000,
  });

describe("connectMcpServer", () => {
  it("mcp_lists_and_reads_resources", async () => {
    const c = await connect({ resources: {} });
    try {
      expect(c.protocolVersion).toBe("2025-06-18");
      expect((await c.listResources()).map((r) => r.uri)).toEqual(["file:///a", "file:///b"]);
      expect(await c.readResource("file:///a")).toEqual([{ uri: "file:///a", text: "hello" }]);
    } finally {
      await c.close();
    }
  });

  it("mcp_lists_and_gets_prompts", async () => {
    const c = await connect({ prompts: {} });
    try {
      const prompts = await c.listPrompts();
      expect(prompts[0]?.arguments?.[0]?.name).toBe("name");
      const got = await c.getPrompt("greet", { name: "Ana" });
      expect(got.messages[0]?.content).toEqual({ type: "text", text: "Hi Ana" });
    } finally {
      await c.close();
    }
  });

  it("mcp_resources_require_the_capability", async () => {
    const c = await connect({ prompts: {} });
    try {
      const err = await c.listResources().catch((e) => e);
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.code).toBe("mcp_capability_missing");
      expect(err.message).toContain("fake");
      expect(err.message).toContain("resources");
    } finally {
      await c.close();
    }
  });

  it("mcp_rpc_error_is_typed", async () => {
    const c = await connect({ resources: {} });
    try {
      const err = await c.readResource("bad").catch((e) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect(err.code).toBe("mcp_rpc_error");
      expect(err.message).toContain("no such resource");
    } finally {
      await c.close();
    }
  });
});
