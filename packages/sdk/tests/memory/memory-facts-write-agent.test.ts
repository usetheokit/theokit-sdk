import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { Agent, addMemoryFact, memoryPartitionId } from "../../src/index.js";
import { messageDelta, sseFrame } from "../helpers/anthropic-sse.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

/** A stub Anthropic server that records the system prompt of every request. */
function startStub(): Promise<{ server: Server; systems: string[] }> {
  const systems: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      systems.push(JSON.stringify((JSON.parse(body) as { system?: unknown }).system ?? ""));
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(sseFrame("message_start", "{}"));
      res.write(messageDelta("end_turn", { input_tokens: 5, output_tokens: 1 }));
      res.write(sseFrame("message_stop", "{}"));
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || a === null) throw new Error("bind failed");
      process.env.ANTHROPIC_API_KEY = "sk-stub";
      process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${a.port}`;
      resolve({ server, systems });
    });
  });
}

describe("addMemoryFact is recalled by an agent with the same settings", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  async function systemFor(cwd: string, userId: string, directory: string): Promise<string> {
    const stub = await startStub();
    server = stub.server;
    const agent = await Agent.create({
      apiKey: "real-not-fixture",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd },
      memory: { enabled: true, userId, directory },
    });
    try {
      await (await agent.send("what do you know?")).wait();
    } finally {
      await agent.dispose();
    }
    return stub.systems.join("\n");
  }

  it("shows the fact to the same userId and not to another", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mfwa-cwd-"));
    const directory = mkdtempSync(join(tmpdir(), "mfwa-dir-"));
    onTestFinished(() => {
      removeTempDirRobustSync(cwd);
      removeTempDirRobustSync(directory);
    });
    const alice = memoryPartitionId("alice");
    await addMemoryFact(cwd, "the okapi lives in the pantry", { userId: alice, directory });

    expect(await systemFor(cwd, alice, directory)).toContain("the okapi lives in the pantry");
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    expect(await systemFor(cwd, memoryPartitionId("bob"), directory)).not.toContain(
      "the okapi lives in the pantry",
    );
  });
});
