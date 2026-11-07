import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import {
  blockStop,
  messageStart,
  messageStop,
  textBlockStart,
  textDelta,
  textReply,
  toolBlockStart,
  toolInputDelta,
} from "./helpers/anthropic-sse.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

/** B-501 — run.stream() yields system, then user, before any assistant or tool message. */

let server: Server | undefined;
afterEach(() => server?.close());

async function streamTypes(replies: string[], withTool: boolean): Promise<string[]> {
  let call = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.end(replies[Math.min(call++, replies.length - 1)]);
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevUrl = process.env.ANTHROPIC_API_BASE_URL;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const agent = await Agent.create({
      apiKey: "real-not-fixture",
      model: { id: "claude-sonnet-4-6" },
      ...(withTool
        ? {
            tools: [
              {
                name: "ping",
                description: "ping",
                inputSchema: { type: "object", properties: {} },
                handler: () => "pong",
              },
            ],
          }
        : {}),
    });
    const run = await agent.send("go");
    const types: string[] = [];
    for await (const m of run.stream()) types.push(m.type);
    agent.dispose();
    return types;
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.ANTHROPIC_API_BASE_URL;
    else process.env.ANTHROPIC_API_BASE_URL = prevUrl;
  }
}

describe("run.stream() init order (B-501)", () => {
  it("yields system once, first, then user, then assistant", async () => {
    const types = await streamTypes([textReply("hello")], false);
    expect(types[0]).toBe("system");
    expect(types[1]).toBe("user");
    expect(types.filter((t) => t === "system")).toHaveLength(1);
    expect(types.indexOf("assistant")).toBeGreaterThan(1);
  });

  it("keeps system first and user before any assistant or tool message on a tool turn", async () => {
    const toolTurn =
      messageStart() +
      toolBlockStart("tu-1", "ping") +
      toolInputDelta("{}") +
      blockStop() +
      messageStop("tool_use");
    const final =
      messageStart() + textBlockStart() + textDelta("done") + blockStop() + messageStop();
    const types = await streamTypes([toolTurn, final], true);
    expect(types[0]).toBe("system");
    expect(types[1]).toBe("user");
    expect(types.filter((t) => t === "system")).toHaveLength(1);
    expect(types.filter((t) => t === "user")).toHaveLength(1);
    expect(types).toContain("assistant");
  });
});
