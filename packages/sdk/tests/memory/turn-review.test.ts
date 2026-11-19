import { mkdtempSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { Agent } from "../../src/index.js";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import { readFacts } from "../../src/internal/memory/storage/markdown-store.js";
import {
  blockStop,
  messageStart,
  messageStop,
  textBlockStart,
  textDelta,
  toolBlockStart,
  toolInputDelta,
} from "../helpers/anthropic-sse.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

interface Body {
  system?: unknown;
  tools?: Array<{ name: string }>;
  messages: unknown[];
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
  setDiagnosticsSink(undefined);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_BASE_URL;
});

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "mem-review-"));
  onTestFinished(() => removeTempDirRobustSync(dir));
  return dir;
}

interface Stub {
  bodies: Body[];
  /** "start:<n>" / "end:<n>" around each reviewer. */
  events: string[];
}

interface StubOptions {
  fact?: string;
  reviewDelayMs?: number;
  reviewStatus?: number;
}

const reply = (res: ServerResponse, ...parts: string[]) => {
  res.setHeader("content-type", "text/event-stream");
  res.write(parts.join(""));
  res.end();
};

/** Answers one reviewer request: a `save_memory` call first, then "done". */
async function answerReviewer(
  res: ServerResponse,
  state: { out: Stub; n: number; opts: StubOptions },
  sawResult: boolean,
): Promise<void> {
  const { out, opts } = state;
  if (sawResult) {
    out.events.push(`end:${state.n}`);
    return reply(
      res,
      messageStart(),
      textBlockStart(),
      textDelta("done"),
      blockStop(),
      messageStop(),
    );
  }
  state.n += 1;
  out.events.push(`start:${state.n}`);
  if (opts.reviewDelayMs) await new Promise((r) => setTimeout(r, opts.reviewDelayMs));
  if (opts.reviewStatus !== undefined) {
    out.events.push(`end:${state.n}`);
    res.statusCode = opts.reviewStatus;
    res.end('{"error":{"type":"api_error","message":"boom"}}');
    return;
  }
  const input = JSON.stringify({ fact: opts.fact ?? "user is in UTC-3" });
  reply(
    res,
    messageStart(),
    toolBlockStart("toolu_1", "save_memory"),
    toolInputDelta(input),
    blockStop(),
    messageStop("tool_use"),
  );
}

/** Chat requests answer "ok"; reviewer requests (they carry `save_memory`) follow `opts`. */
async function stub(opts: StubOptions = {}): Promise<Stub> {
  const state = { out: { bodies: [], events: [] } as Stub, n: 0, opts };
  server = createServer((req, res) => {
    let buf = "";
    req.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
    });
    req.on("end", () => {
      const body = JSON.parse(buf) as Body;
      state.out.bodies.push(body);
      const isReview = body.tools?.some((t) => t.name === "save_memory") === true;
      if (!isReview) {
        return reply(
          res,
          messageStart(),
          textBlockStart(),
          textDelta("ok"),
          blockStop(),
          messageStop(),
        );
      }
      void answerReviewer(res, state, JSON.stringify(body.messages).includes("tool_result"));
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${addr.port}`;
  return state.out;
}

const make = (cwd: string, userId: string, review = true) =>
  Agent.create({
    apiKey: `user-${userId}`,
    model: { id: "claude-sonnet-4-6" },
    local: { cwd, settingSources: ["project"] },
    memory: { enabled: true, userId, ...(review ? { review: { after: "turn" as const } } : {}) },
  });

describe("memory.review (#1026)", () => {
  it("saves a fact into the user's partition, visible to the next agent and not to others", async () => {
    const cwd = tempCwd();
    const s = await stub();
    const a = await make(cwd, "a");
    await (await a.send("I work in UTC-3")).wait();
    await a.memory?.reviewsIdle();
    await a.dispose();

    const reviewReq = s.bodies.find((b) => b.tools?.some((t) => t.name === "save_memory"));
    expect(reviewReq?.tools?.map((t) => t.name)).toEqual(["save_memory"]);
    expect(JSON.stringify(reviewReq?.messages)).toContain("<turn>");

    const before = s.bodies.length;
    const again = await make(cwd, "a", false);
    await (await again.send("hello")).wait();
    await again.dispose();
    expect(JSON.stringify(s.bodies[before]?.system)).toContain("UTC-3");

    const other = await make(cwd, "b", false);
    await (await other.send("hello")).wait();
    await other.dispose();
    expect(JSON.stringify(s.bodies.at(-1)?.system ?? null)).not.toContain("UTC-3");
  });

  it("runs three back-to-back reviews one at a time", async () => {
    const s = await stub({ reviewDelayMs: 40 });
    const agent = await make(tempCwd(), "a");
    for (const t of ["one", "two", "three"]) await (await agent.send(t)).wait();
    await agent.memory?.reviewsIdle();
    await agent.dispose();
    expect(s.events).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
  });

  it("enqueues no review for a cancelled run", async () => {
    const s = await stub();
    const agent = await make(tempCwd(), "a");
    const run = await agent.send("hello");
    await run.cancel();
    await run.wait();
    await agent.memory?.reviewsIdle();
    await agent.dispose();
    expect(s.events).toEqual([]);
  });

  it("enqueues no review for a run that errors", async () => {
    const cwd = tempCwd();
    const s = await stub();
    // The chat request fails: every request carries no save_memory tool, so answer 500 for all.
    server?.removeAllListeners("request");
    server?.on("request", (req, res) => {
      req.resume();
      req.on("end", () => {
        s.events.push("request");
        res.statusCode = 400;
        res.end('{"error":{"type":"invalid_request_error","message":"bad"}}');
      });
    });
    const agent = await make(cwd, "a");
    const result = await (await agent.send("hello")).wait();
    await agent.memory?.reviewsIdle();
    await agent.dispose();
    expect(result.status).toBe("error");
    expect(s.events).toEqual(["request"]);
  });

  it("a failing reviewer does not reject wait() and is reported with the agent id", async () => {
    await stub({ reviewStatus: 400 });
    const messages: string[] = [];
    setDiagnosticsSink((m) => messages.push(m));
    const agent = await make(tempCwd(), "a");
    const result = await (await agent.send("hello")).wait();
    expect(result.status).toBe("finished");
    await agent.memory?.reviewsIdle();
    await agent.dispose();
    const report = messages.find((m) => m.includes("memory review failed"));
    expect(report).toContain((agent as unknown as { agentId: string }).agentId);
  });

  it("save_memory refuses a 501-character fact and stores nothing", async () => {
    const cwd = tempCwd();
    const s = await stub({ fact: "x".repeat(501) });
    const agent = await make(cwd, "a");
    await (await agent.send("hello")).wait();
    await agent.memory?.reviewsIdle();
    await agent.dispose();
    const resultReq = s.bodies.find((b) => JSON.stringify(b.messages).includes("tool_result"));
    expect(JSON.stringify(resultReq?.messages)).toContain("is_error");
    expect(await readFacts(cwd, { enabled: true, userId: "a" })).toEqual([]);
  });
});

describe("memory.review disposal (#1026)", () => {
  it("dispose drops reviews still pending after the timeout and says how many", async () => {
    const { TurnReviewQueue } = await import("../../src/internal/memory/turn-review.js");
    const messages: string[] = [];
    setDiagnosticsSink((m) => messages.push(m));
    const queue = new TurnReviewQueue({
      agentId: "agent-x",
      options: { memory: { enabled: true } },
      workspaceCwd: tempCwd(),
      createAgent: () => new Promise(() => undefined),
    });
    queue.enqueue({ prompt: "p", reply: "r" });
    queue.enqueue({ prompt: "p", reply: "r" });
    await queue.drain(20);
    expect(messages.join("\n")).toMatch(/agent-x.*2 memory review/);
  });
});
