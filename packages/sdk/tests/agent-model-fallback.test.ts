import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { Agent, ModelFallbackExhaustedError, type Run } from "../src/index.js";
import { getSessionMessages } from "../src/internal/session/index.js";
import { messageDelta, sseFrame } from "./helpers/anthropic-sse.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

type Behavior = "fail" | "hang" | { text: string } | { partialThenBreak: string };

function textFrame(text: string): string {
  return sseFrame(
    "content_block_delta",
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
  );
}

/** A stub Anthropic endpoint whose behaviour is chosen by the requested model id. */
function startStub(behaviors: Record<string, Behavior>) {
  const requested: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const model = (JSON.parse(body) as { model: string }).model;
      requested.push(model);
      const b = behaviors[model] ?? "fail";
      if (b === "fail") {
        res.statusCode = 500;
        res.end("boom");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(sseFrame("message_start", "{}"));
      if (b === "hang") return; // never answers: the caller cancels
      if ("partialThenBreak" in b) {
        res.write(textFrame(b.partialThenBreak));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.write(textFrame(b.text));
      res.write(messageDelta("end_turn", { input_tokens: 5, output_tokens: 5 }));
      res.write(sseFrame("message_stop", "{}"));
      res.end();
    });
  });
  return new Promise<{ server: Server; requested: string[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || a === null) throw new Error("bind failed");
      process.env.ANTHROPIC_API_KEY = "sk-stub";
      process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${a.port}`;
      resolve({ server, requested });
    });
  });
}

async function streamedText(run: Run): Promise<string> {
  let text = "";
  for await (const m of run.stream()) {
    if (m.type !== "assistant") continue;
    for (const b of m.message.content) if (b.type === "text") text += b.text;
  }
  return text;
}

const PRIMARY = "claude-sonnet-4-6";
const FB1 = "claude-haiku-4-5";
const FB2 = "claude-opus-4-5";

describe("AgentOptions.modelFallback", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((r) => server?.close(() => r()));
    }
    server = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  async function create(models: string[]) {
    return Agent.create({
      apiKey: "real-not-fixture",
      model: { id: PRIMARY },
      modelFallback: { models },
    });
  }

  it("reruns on the first fallback when the primary fails before output", async () => {
    const stub = await startStub({ [PRIMARY]: "fail", [FB1]: { text: "from fallback" } });
    server = stub.server;
    const agent = await create([FB1, FB2]);
    const run = await agent.send("hello");
    const streamed = await streamedText(run);
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(result.result).toBe("from fallback");
    expect(streamed).toBe("from fallback");
    expect(result.modelAttempts?.map((a) => a.model)).toEqual([PRIMARY, FB1]);
    expect(result.modelAttempts?.[0]).toMatchObject({ outcome: "failed" });
    expect(result.modelAttempts?.[0]?.errorCode).toBeTruthy();
    expect(result.modelAttempts?.[1]).toMatchObject({ outcome: "finished" });
    expect(stub.requested).not.toContain(FB2);
    const users = getSessionMessages(agent.agentId).filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    agent.dispose();
  });

  it("does not fall over once output has streamed", async () => {
    const stub = await startStub({
      [PRIMARY]: { partialThenBreak: "half an ans" },
      [FB1]: { text: "never" },
    });
    server = stub.server;
    const agent = await create([FB1]);
    const run = await agent.send("hello");
    const result = await run.wait();
    expect(result.status).toBe("error");
    expect(stub.requested).toEqual([PRIMARY]);
    expect(result.error?.cause).not.toBeInstanceOf(ModelFallbackExhaustedError);
    agent.dispose();
  });

  it("does not fall over on a run the caller cancelled", async () => {
    const stub = await startStub({ [PRIMARY]: "hang", [FB1]: { text: "never" } });
    server = stub.server;
    const agent = await create([FB1]);
    const run = await agent.send("hello");
    await new Promise((r) => setTimeout(r, 100));
    await run.cancel();
    const result = await run.wait();
    expect(result.status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.requested).toEqual([PRIMARY]);
    agent.dispose();
  });

  it("ends error with ModelFallbackExhaustedError naming every model when all fail", async () => {
    const stub = await startStub({});
    server = stub.server;
    const agent = await create([FB1, FB2]);
    const run = await agent.send("hello");
    const result = await run.wait();
    expect(result.status).toBe("error");
    const cause = result.error?.cause;
    expect(cause).toBeInstanceOf(ModelFallbackExhaustedError);
    for (const m of [PRIMARY, FB1, FB2]) expect(cause?.message).toContain(m);
    expect((cause as ModelFallbackExhaustedError).attempts).toHaveLength(3);
    expect(cause?.cause).toBeDefined();
    expect([...new Set(stub.requested)]).toEqual([PRIMARY, FB1, FB2]);
    agent.dispose();
  });

  it("does not make the fallback the agent's default model for the next turn", async () => {
    const stub = await startStub({ [PRIMARY]: "fail", [FB1]: { text: "ok" } });
    server = stub.server;
    const agent = await create([FB1]);
    await (await agent.send("one")).wait();
    await (await agent.send("two")).wait();
    // Each turn starts on the primary again: the fallback never became the default.
    expect(stub.requested.at(0)).toBe(PRIMARY);
    expect(stub.requested.indexOf(FB1)).toBeGreaterThan(0);
    expect(stub.requested.indexOf(PRIMARY, stub.requested.indexOf(FB1))).toBeGreaterThan(0);
    agent.dispose();
  });
});
