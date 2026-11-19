import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { AgentLike, RunLike } from "@theokit/sdk";
import { describe, expect, it } from "vitest";
import { serveAcp } from "../src/serve.js";
import type { AgentFactory } from "../src/types.js";

const run: RunLike = {
  status: "finished",
  stream: async function* () {},
  wait: async () => ({ status: "finished" }) as never,
  cancel: async () => {},
};
const fake: AgentLike = { agentId: "fake-1", send: async () => run };
// Compile-time proof: a plain AgentLike factory needs no cast.
const factory: AgentFactory = () => fake;

async function drive(permissionDefault: "auto" | "ask", agent: AgentLike) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: Array<{
    id?: number;
    result?: { sessionId?: string; stopReason?: string };
    error?: { data?: unknown };
  }> = [];
  let buf = "";
  stdout.on("data", (d) => {
    buf += String(d);
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) lines.push(JSON.parse(p));
  });
  const done = serveAcp({
    agent: () => agent,
    permissionDefault,
    stdin,
    stdout,
    log: () => {},
  });
  const call = async (id: number, method: string, params: unknown) => {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (let n = 0; n < 200; n++) {
      const m = lines.find((l) => l.id === id);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no response");
  };
  await call(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  const cwd = mkdtempSync(`${tmpdir()}/acp-al-`);
  const created = await call(2, "session/new", { cwd, mcpServers: [] });
  return { call, created, stdin, done };
}

describe("serveAcp accepts AgentLike", () => {
  it("accepts a factory typed as AgentFactory", async () => {
    expect(await factory("s")).toBe(fake);
  });

  it("serves a prompt and closes without dispose", async () => {
    const { call, created, stdin, done } = await drive("auto", fake);
    const sessionId = created.result?.sessionId as string;
    const res = await call(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(res.result?.stopReason).toBeDefined();
    stdin.end();
    await expect(done).resolves.toBeUndefined();
  });

  it("fails closed on session/new when ask mode has no pluginManager", async () => {
    const { created, stdin, done } = await drive("ask", fake);
    expect(created.error?.data).toEqual({ code: "permission_enforcement_unavailable" });
    stdin.end();
    await done;
  });
});
