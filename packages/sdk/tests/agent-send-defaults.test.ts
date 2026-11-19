import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { messageDelta, sseFrame } from "./helpers/anthropic-sse.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

/** Stub provider: first request calls `lookup`, later ones answer. Records request bodies. */
async function startStub(): Promise<{ server: Server; url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      bodies.push(body);
      const hasResult = body.includes("tool_result");
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(sseFrame("message_start", "{}"));
      if (hasResult) {
        res.write(
          sseFrame(
            "content_block_delta",
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "done" },
            }),
          ),
        );
        res.write(messageDelta("end_turn", { input_tokens: 5, output_tokens: 1 }));
      } else {
        res.write(
          sseFrame(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "tu-1", name: "lookup", input: {} },
            }),
          ),
        );
        res.write(
          sseFrame(
            "content_block_delta",
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{}" },
            }),
          ),
        );
        res.write(
          sseFrame("content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })),
        );
        res.write(messageDelta("tool_use", { input_tokens: 5, output_tokens: 1 }));
      }
      res.write(sseFrame("message_stop", "{}"));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  if (typeof a !== "object" || a === null) throw new Error("bind failed");
  return { server, url: `http://127.0.0.1:${a.port}`, bodies };
}

const lookupTool = {
  name: "lookup",
  description: "Look something up.",
  inputSchema: { type: "object" as const, properties: {} },
  handler: () => "mail alice@example.com now",
};

describe("AgentOptions.sendDefaults", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  async function setup(extra: Record<string, unknown>) {
    const stub = await startStub();
    server = stub.server;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    const agent = await Agent.create({
      apiKey: "real-not-fixture",
      model: { id: "claude-sonnet-4-6" },
      tools: [lookupTool],
      ...extra,
    });
    return { agent, bodies: stub.bodies };
  }

  it("a plain send wraps tool output in <untrusted-tool-output>", async () => {
    const { agent, bodies } = await setup({ sendDefaults: { toolResultGuard: { delimit: true } } });
    await (await agent.send("go")).wait();
    expect(bodies.some((b) => b.includes("untrusted-tool-output"))).toBe(true);
    agent.dispose();
  });

  it("the call's toolResultGuard replaces the default guard", async () => {
    const { agent, bodies } = await setup({ sendDefaults: { toolResultGuard: { delimit: true } } });
    await (await agent.send("go", { toolResultGuard: { redactPii: true } })).wait();
    const withResult = bodies.filter((b) => b.includes("tool_result")).join("\n");
    expect(withResult).toContain("[REDACTED]");
    expect(withResult).not.toContain("untrusted-tool-output");
    agent.dispose();
  });

  it("an explicit undefined keeps the default", async () => {
    const { agent, bodies } = await setup({ sendDefaults: { toolResultGuard: { delimit: true } } });
    await (await agent.send("go", { toolResultGuard: undefined })).wait();
    expect(bodies.some((b) => b.includes("untrusted-tool-output"))).toBe(true);
    agent.dispose();
  });

  it("an invalid pruneToolResults default rejects at Agent.create before any provider call", async () => {
    const stub = await startStub();
    server = stub.server;
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    await expect(
      Agent.create({
        apiKey: "real-not-fixture",
        model: { id: "claude-sonnet-4-6" },
        sendDefaults: { pruneToolResults: { olderThanRounds: 0 } },
      }),
    ).rejects.toMatchObject({ name: "ConfigurationError", code: "invalid_prune_tool_results" });
    expect(stub.bodies).toHaveLength(0);
  });
});
