import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { BuiltinToolName } from "../src/index.js";
import { Agent, BUILTIN_TOOL_NAMES, isBuiltinToolName } from "../src/index.js";
import { resolveMemoryRoot } from "../src/internal/memory/storage/memory-root.js";
import { sseFrame } from "./helpers/anthropic-sse.js";
import { removeTempDirRobust } from "./helpers/temp-workspace.js";

// Mutual assignability: a missing or extra name fails `pnpm typecheck`.
type Derived = (typeof BUILTIN_TOOL_NAMES)[number];
const _toDerived = (n: BuiltinToolName): Derived => n;
const _toUnion = (n: Derived): BuiltinToolName => n;
void _toDerived;
void _toUnion;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    req.on("end", () => resolve(buf));
  });
}

async function startStubAnthropic(): Promise<{
  server: Server;
  url: string;
  captured: { body?: { tools?: Array<{ name: string }> } };
}> {
  const captured: { body?: { tools?: Array<{ name: string }> } } = {};
  const server = createServer(async (req, res) => {
    captured.body = JSON.parse(await readBody(req));
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    const sse = (event: string, data: string): void => {
      res.write(sseFrame(event, data));
    };
    sse("message_start", "{}");
    sse(
      "content_block_delta",
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
    );
    sse(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    sse("message_stop", "{}");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
  return { server, url: `http://127.0.0.1:${addr.port}`, captured };
}

describe("BUILTIN_TOOL_NAMES", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((r) => server?.close(() => r()));
      server = undefined;
    }
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  it("is exactly the set of tools a local agent with memory enabled registers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "theokit-builtin-names-"));
    onTestFinished(async () => {
      await removeTempDirRobust(cwd);
    });
    await mkdir(resolveMemoryRoot(cwd), { recursive: true });
    const stub = await startStubAnthropic();
    server = stub.server;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;

    const agent = await Agent.create({
      apiKey: "user-builtin-names",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      memory: { enabled: true },
    });
    await (await agent.send("anything")).wait();

    const registered = (stub.captured.body?.tools ?? []).map((t) => t.name);
    expect([...registered].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  it("recognises each builtin", () => {
    for (const name of BUILTIN_TOOL_NAMES) expect(isBuiltinToolName(name)).toBe(true);
  });

  it("rejects a name that is not a builtin", () => {
    expect(isBuiltinToolName("read_file")).toBe(false);
  });
});
