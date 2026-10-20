/**
 * `run.cancel()` on a local run must abort the provider stream, not only the run's status.
 *
 * The README ("Cancelling a run") and `Run.cancel()` in `types/run.ts` say the live stream aborts.
 * A loop-surface-closure audit against live OpenRouter saw the opposite: `cancel()` resolved and
 * `wait()` returned `cancelled`, while `onDelta` kept receiving `thinking-delta` updates for the
 * whole observation window and the provider billed the generation.
 *
 * This file runs the same path against a local chat-completions endpoint that never stops on its
 * own: it writes OpenRouter reasoning chunks every 50 ms for up to 10 s, so the only way the
 * response can end early is the client going away. Hermetic: no key, no network.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../src/index.js";
import { Agent } from "../src/index.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd("theokit-run-cancel-");

const CHUNK_INTERVAL_MS = 50;
const SERVER_STREAM_LIMIT_MS = 10_000;
const ABORT_DEADLINE_MS = 1_000;
const POST_CANCEL_WINDOW_MS = 2_000;
const CANCEL_RESOLVE_BUDGET_MS = 50;
const STUB_KEY = "sk-or-stub-0000000000";

interface EndlessReasoningServer {
  server: Server;
  url: string;
  /** Number of POSTs to a path ending in `/chat/completions`. */
  chatRequests: number;
  /** Whether the server is still writing chunks to the open response. */
  writing: boolean;
  /** `Date.now()` when the response emitted `close`, or undefined while it is open. */
  responseClosedAt: number | undefined;
}

function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => undefined);
    req.on("end", () => resolve());
  });
}

function reasoningChunk(seq: number): string {
  // Built in steps: a template literal nested inside another made lizard read this function as
  // running to the end of the file (CCN 16), which the item's complexity gate then refused.
  const reasoning = `step ${String(seq)}. `;
  const record = JSON.stringify({
    choices: [{ index: 0, delta: { reasoning }, finish_reason: null }],
  });
  return `data: ${record}\n\n`;
}

/**
 * `chunksPerWrite` > 1 puts several SSE records in ONE socket write, so the client parses them
 * from one read: the second is already parsed, and on its way to `onDelta`, when the first one's
 * handler runs. That is the "delta already in flight" case an abort alone cannot stop.
 */
async function startEndlessReasoningServer(chunksPerWrite = 1): Promise<EndlessReasoningServer> {
  const state: EndlessReasoningServer = {
    server: undefined as unknown as Server,
    url: "",
    chatRequests: 0,
    writing: false,
    responseClosedAt: undefined,
  };
  state.server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url?.endsWith("/chat/completions") !== true) {
      res.statusCode = 404;
      res.end();
      return;
    }
    state.chatRequests += 1;
    await drainBody(req);
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    state.writing = true;
    const startedAt = Date.now();
    let seq = 0;
    const timer = setInterval(() => {
      if (Date.now() - startedAt > SERVER_STREAM_LIMIT_MS) {
        clearInterval(timer);
        state.writing = false;
        res.end();
        return;
      }
      let payload = "";
      for (let i = 0; i < chunksPerWrite; i += 1) {
        seq += 1;
        payload += reasoningChunk(seq);
      }
      res.write(payload);
    }, CHUNK_INTERVAL_MS);
    res.on("close", () => {
      clearInterval(timer);
      state.writing = false;
      state.responseClosedAt = Date.now();
    });
  });
  await new Promise<void>((resolve) => state.server.listen(0, "127.0.0.1", () => resolve()));
  const addr = state.server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
  state.url = `http://127.0.0.1:${String(addr.port)}`;
  return state;
}

/** Polls `condition` until it holds or `deadlineMs` passes; returns whether it held. */
async function pollUntil(condition: () => boolean, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return condition();
}

describe("run.cancel() aborts the provider stream on a local run", () => {
  let stub: EndlessReasoningServer | undefined;
  afterEach(async () => {
    if (stub !== undefined) {
      stub.server.closeAllConnections();
      await new Promise<void>((r) => stub?.server.close(() => r()));
      stub = undefined;
    }
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_BASE_URL;
  });

  async function reasoningAgent(chunksPerWrite = 1): Promise<{
    agent: Awaited<ReturnType<typeof Agent.create>>;
    server: EndlessReasoningServer;
  }> {
    stub = await startEndlessReasoningServer(chunksPerWrite);
    process.env.OPENROUTER_API_KEY = STUB_KEY;
    process.env.OPENROUTER_API_BASE_URL = stub.url;
    const agent = await Agent.create({
      apiKey: STUB_KEY,
      model: { id: "deepseek/deepseek-r1-0528", params: [{ id: "thinking", value: "high" }] },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
      local: { cwd: process.cwd() },
    });
    return { agent, server: stub };
  }

  interface CancelledTurn {
    server: EndlessReasoningServer;
    /** Every InteractionUpdate, of any type, that reached onDelta after cancel was called. */
    updatesAfterCancel: number;
    cancelledAt: number;
    cancelResolvedInMs: number;
    writingWhenCancelled: boolean;
    run: Run;
  }

  /** Starts a reasoning turn, cancels it after the first thinking-delta, and returns what followed. */
  async function cancelMidReasoning(observeMs: number): Promise<CancelledTurn> {
    const { agent, server } = await reasoningAgent();
    let cancelled = false;
    let updatesAfterCancel = 0;
    let thinkingBeforeCancel = 0;
    const run = await agent.send("List the prime numbers below 200.", {
      onDelta: ({ update }) => {
        if (cancelled) updatesAfterCancel += 1;
        else if (update.type === "thinking-delta") thinkingBeforeCancel += 1;
      },
    });
    try {
      const streamed = await pollUntil(() => thinkingBeforeCancel > 0, 5_000);
      expect(streamed, "the stub never delivered a thinking-delta before cancel").toBe(true);
      expect(server.chatRequests).toBe(1);
      cancelled = true;
      const cancelledAt = Date.now();
      await run.cancel();
      const cancelResolvedInMs = Date.now() - cancelledAt;
      const writingWhenCancelled = server.writing;
      await run.wait();
      // Waits for the abort; if it never comes, the whole window is observed and every chunk the
      // stub wrote in it had its chance to reach onDelta.
      await pollUntil(() => server.responseClosedAt !== undefined, observeMs);
      // The window itself is the behaviour under test: zero updates must hold until
      // cancelledAt + observeMs, not only until the response closes, so a delta that arrives late
      // is still counted. A timed wait is allowed here (rules/testing.md § 3) for that reason.
      await pollUntil(() => Date.now() >= cancelledAt + observeMs, observeMs + 1_000);
      return {
        server,
        updatesAfterCancel,
        cancelledAt,
        cancelResolvedInMs,
        writingWhenCancelled,
        run,
      };
    } finally {
      await agent.dispose();
    }
  }

  // Control for the fixture (EC-2): an abort that DOES reach the fetch is visible to this stub as
  // the response closing. Without it, a red "still open" below could be the stub failing to notice.
  it("observes the response closing when SendOptions.signal aborts the fetch", async () => {
    const { agent, server } = await reasoningAgent();
    const controller = new AbortController();
    let deltas = 0;
    try {
      const run = await agent.send("List the prime numbers below 200.", {
        signal: controller.signal,
        onDelta: () => {
          deltas += 1;
        },
      });
      expect(await pollUntil(() => deltas > 0, 5_000)).toBe(true);
      const abortedAt = Date.now();
      controller.abort();
      expect(await pollUntil(() => server.responseClosedAt !== undefined, ABORT_DEADLINE_MS)).toBe(
        true,
      );
      expect((server.responseClosedAt ?? Number.POSITIVE_INFINITY) - abortedAt).toBeLessThanOrEqual(
        ABORT_DEADLINE_MS,
      );
      await run.wait();
    } finally {
      await agent.dispose();
    }
  });

  it("delivers no InteractionUpdate of any type to onDelta after cancel resolves", async () => {
    const turn = await cancelMidReasoning(POST_CANCEL_WINDOW_MS);
    // EC-1: a stream that had already ended would make a zero here meaningless.
    expect(turn.writingWhenCancelled).toBe(true);
    expect(turn.updatesAfterCancel).toBe(0);
  });

  it("closes the provider response within one second of cancel", async () => {
    const turn = await cancelMidReasoning(ABORT_DEADLINE_MS);
    expect(turn.writingWhenCancelled).toBe(true);
    const closedAfterMs =
      turn.server.responseClosedAt === undefined
        ? undefined
        : turn.server.responseClosedAt - turn.cancelledAt;
    expect(
      closedAfterMs !== undefined && closedAfterMs <= ABORT_DEADLINE_MS,
      `provider response still open ${String(ABORT_DEADLINE_MS)} ms after cancel (closedAfterMs=${String(closedAfterMs)})`,
    ).toBe(true);
  });

  // An abort stops the READ, not records already parsed from the last read. Two records arrive in
  // one write; the caller cancels while handling the first. The second must not reach onDelta.
  it("drops a delta already parsed when cancel runs inside onDelta", async () => {
    const { agent, server } = await reasoningAgent(2);
    let cancelled = false;
    let updatesAfterCancel = 0;
    let run: Run | undefined;
    try {
      run = await agent.send("List the prime numbers below 200.", {
        onDelta: ({ update }) => {
          if (cancelled) {
            updatesAfterCancel += 1;
            return;
          }
          if (update.type !== "thinking-delta" || run === undefined) return;
          cancelled = true;
          void run.cancel();
        },
      });
      expect(await pollUntil(() => cancelled, 5_000), "no thinking-delta reached onDelta").toBe(
        true,
      );
      expect(server.chatRequests).toBe(1);
      await run.wait();
      await pollUntil(() => server.responseClosedAt !== undefined, ABORT_DEADLINE_MS);
      expect(updatesAfterCancel).toBe(0);
    } finally {
      await agent.dispose();
    }
  });

  it("resolves cancel within 50 ms while the stream is open", async () => {
    const turn = await cancelMidReasoning(ABORT_DEADLINE_MS);
    expect(turn.writingWhenCancelled).toBe(true);
    expect(turn.cancelResolvedInMs).toBeLessThanOrEqual(CANCEL_RESOLVE_BUDGET_MS);
  });

  // Why usage and cost stay absent: the result resolves at cancel time, and OpenRouter reports
  // token usage only in the stream's final chunk, which an aborted stream never receives.
  it("reports no usage or cost for a cancelled turn because the provider sends usage in the final chunk", async () => {
    const turn = await cancelMidReasoning(ABORT_DEADLINE_MS);
    const result = await turn.run.wait();
    expect(result.status).toBe("cancelled");
    // The abort must not surface as an error on a run the caller cancelled.
    expect(result.error).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(result.cost).toBeUndefined();
  });
});
