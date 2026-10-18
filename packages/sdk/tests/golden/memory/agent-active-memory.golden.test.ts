import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { Agent } from "../../../src/index.js";
import { memoryMdPath } from "../../../src/internal/memory/storage/markdown-store.js";
import { resolveMemoryRoot } from "../../../src/internal/memory/storage/memory-root.js";
import { sseFrame } from "../../helpers/anthropic-sse.js";
import { removeTempDirRobust } from "../../helpers/temp-workspace.js";

/**
 * B-412: a body for an Anthropic-family model carries `system` as text blocks, the configured
 * prompt first and cacheable, so an assertion about the prompt's text reads every block's text.
 * A string is returned as is.
 */
function systemText(system: unknown): string | undefined {
  if (system === undefined || typeof system === "string") return system;
  if (!Array.isArray(system)) throw new Error(`unexpected system shape: ${JSON.stringify(system)}`);
  return system.map((block: { text: string }) => block.text).join("\n\n");
}

/**
 * Increment B — when `memory.activeRecall.enabled === true`, the SDK must
 * prepend an `<active-memory>` block to the LLM's system prompt with the
 * recall summary from `runActiveMemory`.
 */

interface Captured {
  body: Record<string, unknown> | undefined;
}

async function startStubAnthropic(): Promise<{ server: Server; url: string; captured: Captured }> {
  const captured: Captured = { body: undefined };
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/messages") {
      res.statusCode = 404;
      res.end();
      return;
    }
    captured.body = JSON.parse(await readBody(req)) as Record<string, unknown>;
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    req.on("end", () => resolve(buf));
  });
}

describe("Active Memory wired through Agent.send", () => {
  let cwd: string;
  let server: Server | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-activewire-"));
    const __cwdCleanup1 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup1);
    });
    await mkdir(resolveMemoryRoot(cwd), { recursive: true });
    await writeFile(
      memoryMdPath(resolveMemoryRoot(cwd)),
      "# Memory\n\n## Facts\n\n- the magic-number for this workspace is 8675309.\n- another unrelated fact about cats.\n",
      "utf8",
    );
  });

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((r) => server?.close(() => r()));
      server = undefined;
    }
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  it("prepends <active-memory> block when activeRecall.enabled", async () => {
    const stub = await startStubAnthropic();
    server = stub.server;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    const agent = await Agent.create({
      apiKey: "user-real-activewire",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      memory: {
        enabled: true,
        activeRecall: { enabled: true, queryMode: "message", maxSummaryChars: 1000 },
      },
    });
    await (await agent.send("magic-number")).wait();
    const system = systemText(stub.captured.body?.system);
    expect(system).toBeDefined();
    expect(system).toContain("<active-memory>");
    expect(system).toContain("8675309");
  });

  it("omits <active-memory> when activeRecall.enabled is false", async () => {
    const stub = await startStubAnthropic();
    server = stub.server;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    const agent = await Agent.create({
      apiKey: "user-real-activewire-off",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      memory: { enabled: true },
    });
    await (await agent.send("magic-number")).wait();
    const system = systemText(stub.captured.body?.system) ?? "";
    expect(system).not.toContain("<active-memory>");
  });
});
