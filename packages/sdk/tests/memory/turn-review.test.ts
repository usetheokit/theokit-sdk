import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../src/agent.js";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import { createTurnReviewQueue } from "../../src/internal/memory/review/turn-review.js";
import type { AgentOptions } from "../../src/types/agent.js";
import {
  blockStop,
  messageStart,
  messageStop,
  textReply,
  toolBlockStart,
  toolInputDelta,
} from "../helpers/anthropic-sse.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

interface Stub {
  server: Server;
  url: string;
  mainBodies: string[];
  reviewerTools: string[][];
  events: string[];
  followUps: string[];
}

/** Anthropic wire stub: a request that offers `save_memory` is the reviewer, anything else the chat. */
function startStub(opts: { facts: () => string; reviewDelayMs?: number; mainDelayMs?: number }) {
  const stub: Stub = {
    server: undefined as never,
    url: "",
    mainBodies: [],
    reviewerTools: [],
    events: [],
    followUps: [],
  };
  let reviewNo = 0;
  stub.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      void respond(raw, res);
    });
  });
  type Res = import("node:http").ServerResponse;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function respondMain(raw: string, res: Res): Promise<void> {
    stub.mainBodies.push(raw);
    await sleep(opts.mainDelayMs ?? 0);
    if (raw.includes("FAIL-TURN")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "boom" } }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.end(textReply("noted"));
  }
  async function respondReviewer(raw: string, tools: string[], res: Res): Promise<void> {
    res.setHeader("content-type", "text/event-stream");
    if (raw.includes("tool_result")) {
      stub.followUps.push(raw);
      await sleep(opts.reviewDelayMs ?? 0);
      stub.events.push(`end:${reviewNo}`);
      res.end(textReply("done"));
      return;
    }
    if (raw.includes("THROW-REVIEW")) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ error: { type: "invalid_request_error", message: "reviewer broke" } }),
      );
      return;
    }
    reviewNo += 1;
    stub.events.push(`start:${reviewNo}`);
    stub.reviewerTools.push(tools);
    await sleep(opts.reviewDelayMs ?? 0);
    const input = JSON.stringify({ fact: opts.facts() });
    res.end(
      messageStart() +
        toolBlockStart("tu-1", "save_memory") +
        toolInputDelta(input) +
        blockStop() +
        messageStop("tool_use"),
    );
  }
  async function respond(raw: string, res: Res): Promise<void> {
    const body = JSON.parse(raw) as { tools?: { name: string }[] };
    const tools = (body.tools ?? []).map((t) => t.name);
    if (tools.includes("save_memory")) await respondReviewer(raw, tools, res);
    else await respondMain(raw, res);
  }
  return new Promise<Stub>((resolve) => {
    stub.server.listen(0, "127.0.0.1", () => {
      const a = stub.server.address();
      if (typeof a !== "object" || a === null) throw new Error("bind failed");
      stub.url = `http://127.0.0.1:${a.port}`;
      resolve(stub);
    });
  });
}

describe("memory.review", () => {
  useTempCwd();

  let stub: Stub;
  let root: string;
  let messages: string[];
  const prev = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_API_BASE_URL };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "theokit-review-"));
    messages = [];
    setDiagnosticsSink((m) => messages.push(m));
  });

  afterEach(async () => {
    setDiagnosticsSink(undefined);
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
    if (prev.url === undefined) delete process.env.ANTHROPIC_API_BASE_URL;
    else process.env.ANTHROPIC_API_BASE_URL = prev.url;
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function boot(opts: Parameters<typeof startStub>[0]): Promise<void> {
    stub = await startStub(opts);
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
  }

  function create(
    userId: string,
    review = true,
  ): Promise<Awaited<ReturnType<typeof Agent.create>>> {
    return Agent.create({
      apiKey: "real-not-fixture",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd: root },
      memory: {
        enabled: true,
        userId,
        directory: join(root, "mem"),
        ...(review ? { review: { after: "turn" } } : {}),
      },
    } as AgentOptions);
  }

  it("saves a fact for the same userId only, with save_memory as the only tool", async () => {
    await boot({ facts: () => "user is in UTC-3" });
    const alice = await create("alice");
    await (await alice.send("I work in UTC-3")).wait();
    await alice.memory?.reviewsIdle?.();
    await alice.dispose();

    expect(stub.reviewerTools).toEqual([["save_memory"]]);

    const again = await create("alice", false);
    await (await again.send("hello")).wait();
    await again.dispose();
    expect(stub.mainBodies.at(-1)).toContain("user is in UTC-3");

    const bob = await create("bob", false);
    await (await bob.send("hello")).wait();
    await bob.dispose();
    expect(stub.mainBodies.at(-1)).not.toContain("user is in UTC-3");
  });

  it("never overlaps reviews of three turns sent back to back", async () => {
    await boot({ facts: () => "a fact", reviewDelayMs: 40 });
    const agent = await create("alice");
    const runs = [];
    for (const text of ["one", "two", "three"]) runs.push(await agent.send(text));
    await Promise.all(runs.map((r) => r.wait()));
    await agent.memory?.reviewsIdle?.();
    await agent.dispose();
    expect(stub.events).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
  });

  it("queues no review for a run that ends error or cancelled", async () => {
    await boot({ facts: () => "never", mainDelayMs: 150 });
    const agent = await create("alice");
    const failed = await agent.send("FAIL-TURN");
    expect((await failed.wait()).status).toBe("error");
    const cancelled = await agent.send("cancel me");
    await cancelled.cancel();
    expect((await cancelled.wait()).status).toBe("cancelled");
    await agent.memory?.reviewsIdle?.();
    await agent.dispose();
    expect(stub.reviewerTools).toEqual([]);
  });

  it("reports a failing review on diagnostics with the agent id and keeps wait() resolved", async () => {
    await boot({ facts: () => "x" });
    const agent = await create("alice");
    const run = await agent.send("THROW-REVIEW please");
    await expect(run.wait()).resolves.toMatchObject({ status: "finished" });
    await agent.memory?.reviewsIdle?.();
    const next = await agent.send("and again");
    await expect(next.wait()).resolves.toMatchObject({ status: "finished" });
    const report = messages.find((m) => m.includes("memory review failed"));
    expect(report).toContain((agent as unknown as { agentId: string }).agentId);
    await agent.dispose();
  });

  it("refuses a 501-character fact with a tool error and stores nothing", async () => {
    await boot({ facts: () => "z".repeat(501) });
    const agent = await create("alice");
    await (await agent.send("long")).wait();
    await agent.memory?.reviewsIdle?.();
    await agent.dispose();
    const again = await create("alice", false);
    await (await again.send("hello")).wait();
    await again.dispose();
    expect(stub.followUps).toHaveLength(1);
    expect(stub.followUps[0]).toMatch(/"is_error":\s*true/);
    expect(stub.followUps[0]).toContain("501 characters");
    expect(stub.mainBodies.at(-1)).not.toContain("zzzzzzzzzz");
  });

  it("dispose waits for queued reviews", async () => {
    await boot({ facts: () => "user likes tea", reviewDelayMs: 40 });
    const agent = await create("alice");
    await (await agent.send("tea")).wait();
    await agent.dispose();
    const again = await create("alice", false);
    await (await again.send("hello")).wait();
    await again.dispose();
    expect(stub.mainBodies.at(-1)).toContain("user likes tea");
  });

  it("forwards providers, modelFallback and apiKey to the reviewer agent", async () => {
    const seen: AgentOptions[] = [];
    const providers = { routes: { "x/*": "openrouter" } };
    const modelFallback = { models: ["claude-haiku-4-5"] };
    const options = {
      apiKey: "k",
      model: { id: "m" },
      providers,
      modelFallback,
    } as unknown as AgentOptions;
    const queue = createTurnReviewQueue(
      {
        agentId: "a",
        workspaceCwd: root,
        options,
        create: async (o) => {
          seen.push(o);
          throw new Error("stop");
        },
      },
      { after: "turn" },
      { enabled: true },
    );
    queue.enqueue({ prompt: "p", reply: "r" });
    await queue.idle();
    expect(seen[0]).toMatchObject({ apiKey: "k", providers, modelFallback });
  });
});
