import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { Agent, type ConversationRef, Plugin, type PreToolCallContext } from "../src/index.js";
import { messageDelta, sseFrame } from "./helpers/anthropic-sse.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

function startStub(): Promise<{ server: Server; url: string }> {
  let i = 0;
  const server = createServer((_req, res) => {
    const tool = i % 2 === 0;
    i += 1;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.write(sseFrame("message_start", "{}"));
    if (tool) {
      res.write(
        sseFrame(
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: `tu-${i}`, name: "lookup", input: {} },
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
      res.write(messageDelta("tool_use", { input_tokens: 10, output_tokens: 5 }));
    } else {
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
      res.write(messageDelta("end_turn", { input_tokens: 20, output_tokens: 5 }));
    }
    res.write(sseFrame("message_stop", "{}"));
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || a === null) throw new Error("bind failed");
      resolve({ server, url: `http://127.0.0.1:${a.port}` });
    });
  });
}

describe("PreToolCallContext.conversation (#1032)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  async function runOnce(
    agentConversation: ConversationRef | undefined,
    sendConversation: ConversationRef | undefined,
  ): Promise<PreToolCallContext> {
    const stub = await startStub();
    server = stub.server;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;

    const seen: PreToolCallContext[] = [];
    const plugin = Plugin.create({
      name: "spy",
      version: "1.0.0",
      kind: "general",
      register: (ctx) => {
        ctx.on("pre_tool_call", (c) => {
          seen.push(c as PreToolCallContext);
          return undefined;
        });
      },
    });
    const agent = await Agent.create({
      apiKey: "real-not-fixture",
      model: { id: "claude-sonnet-4-6" },
      plugins: [plugin],
      tools: [
        {
          name: "lookup",
          description: "Look something up.",
          inputSchema: { type: "object", properties: {} },
          handler: () => "ok",
        },
      ],
      ...(agentConversation !== undefined ? { conversation: agentConversation } : {}),
    });
    const run = await agent.send(
      "go",
      sendConversation !== undefined ? { conversation: sendConversation } : {},
    );
    await run.wait();
    agent.dispose();
    expect(seen.length).toBeGreaterThan(0);
    return seen[0] as PreToolCallContext;
  }

  it("a pre_tool_call plugin receives the conversation set on AgentOptions", async () => {
    const conversation = { platform: "slack", channelId: "C1", sessionKey: "s1" };
    const ctx = await runOnce(conversation, undefined);
    expect(ctx.conversation).toEqual(conversation);
  });

  it("SendOptions.conversation overrides AgentOptions.conversation for that run", async () => {
    const ctx = await runOnce({ platform: "slack", sessionKey: "agent" }, { sessionKey: "send" });
    expect(ctx.conversation).toEqual({ sessionKey: "send" });
  });

  it("without a conversation the context has no conversation key", async () => {
    const ctx = await runOnce(undefined, undefined);
    expect("conversation" in ctx).toBe(false);
  });
});
