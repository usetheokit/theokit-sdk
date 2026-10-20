/**
 * A run cancelled while its MCP servers initialize must not start a turn, and must still close
 * the MCP clients it owns.
 *
 * `driveLoop` checks `terminated` once, then awaits `initializeMcp`, then runs the loop. A cancel
 * that lands during that await used to start a turn anyway: hooks ran and a turn was built for a
 * run the caller had already stopped. The guard sits inside the `try` of `executeAgentLoop`, so the
 * `finally` that releases run-owned MCP clients still runs; this test watches both halves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import type { SDKMessage } from "../../src/types/messages.js";
import { pollUntil } from "../helpers/poll-until.js";

const closes: string[] = [];
/** When set, `close()` records the call and then rejects with this error. */
let closeFailure: Error | undefined;
let initializeCalls = 0;
let releaseInitialize: (() => void) | undefined;

vi.mock("../../src/internal/mcp/client.js", () => ({
  createMcpClient: (name: string) => ({
    name,
    initialize: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          initializeCalls += 1;
          releaseInitialize = resolve;
        }),
    ),
    close: vi.fn(async () => {
      closes.push(name);
      if (closeFailure !== undefined) throw closeFailure;
    }),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({})),
  }),
}));

// The loop itself is out of scope: what matters is whether it is called at all.
vi.mock("../../src/internal/agent-loop/loop.js", () => ({
  runAgentLoop: vi.fn(async () => ({
    events: [],
    finalStatus: "completed",
    result: "ok",
    conversation: [],
  })),
}));

const { createRealLocalRun } = await import("../../src/internal/local-agent/real-local-run.js");
const { runAgentLoop } = await import("../../src/internal/agent-loop/loop.js");
type RunUnderTest = ReturnType<typeof createRealLocalRun>;

function startRunWithOneMcpServer() {
  return createRealLocalRun({
    agentId: "agent-cancel-during-init",
    model: { id: "claude-sonnet-4-6" },
    message: "hello",
    agentOptions: {
      apiKey: "sk-ant-test-key",
      mcpServers: { fs: { command: "node", args: ["fs-server.js"] } },
    },
    sendOptions: {},
    workspaceCwd: process.cwd(),
    hooks: {} as never,
  } as never);
}

describe("a run cancelled while its MCP servers initialize", () => {
  beforeEach(() => {
    closes.length = 0;
    initializeCalls = 0;
    releaseInitialize = undefined;
    closeFailure = undefined;
    vi.mocked(runAgentLoop).mockClear();
  });
  afterEach(() => {
    setDiagnosticsSink(undefined);
  });

  it("starts no loop turn, and still closes the MCP client it owns", async () => {
    const run = startRunWithOneMcpServer();

    await pollUntil(() => initializeCalls > 0, {
      deadlineMs: 2_000,
      message: "initialize was never called",
    });
    await run.cancel();
    releaseInitialize?.();

    await pollUntil(() => closes.length > 0, {
      deadlineMs: 2_000,
      message: "the owned client was never closed",
    });
    expect(vi.mocked(runAgentLoop)).toHaveBeenCalledTimes(0);
    expect(closes).toEqual(["fs"]);
    expect((await run.wait()).status).toBe("cancelled");
  });

  // The guard above leans on the `finally` to release the clients; a close that fails there must
  // say so, naming the server, instead of leaving a possibly running MCP child with no trace.
  it("reports a failed close of an owned MCP client through diagnostics, naming the server", async () => {
    const reported: string[] = [];
    setDiagnosticsSink((message) => {
      reported.push(message);
    });
    closeFailure = new Error("EPIPE: child already gone");
    const run = startRunWithOneMcpServer();

    await pollUntil(() => initializeCalls > 0, {
      deadlineMs: 2_000,
      message: "initialize was never called",
    });
    await run.cancel();
    releaseInitialize?.();

    await pollUntil(() => reported.some((m) => m.includes("failed to close")), {
      deadlineMs: 2_000,
      message: () => `no close failure was reported; diagnostics: ${JSON.stringify(reported)}`,
    });
    const report = reported.find((m) => m.includes("failed to close")) ?? "";
    expect(report).toContain("fs");
    expect(report).toContain("EPIPE: child already gone");
    expect((await run.wait()).status).toBe("cancelled");
  });
});

// wait() resolves at cancel time while the loop is still unwinding. What the loop reports after
// that (the "[aborted]" assistant event, its returned events and conversation) used to land in the
// run anyway, so stream(), events() and conversation() answered differently depending on when they
// were read (loop-code-review LCR0111). The owned MCP client's close() runs in the `finally`, after
// the loop's output is applied, so it is the signal that the loop has fully unwound.
describe("a run cancelled while its loop is running", () => {
  beforeEach(() => {
    closes.length = 0;
    initializeCalls = 0;
    releaseInitialize = undefined;
    closeFailure = undefined;
    vi.mocked(runAgentLoop).mockClear();
  });

  async function snapshot(run: RunUnderTest) {
    const messages: unknown[] = [];
    for await (const message of run.stream()) messages.push(message);
    const timeline: unknown[] = [];
    for await (const event of run.events()) timeline.push(event);
    return { messages, timeline, conversation: [...(await run.conversation())] };
  }

  it("keeps stream(), events() and conversation() unchanged after wait() resolves", async () => {
    let loopStarted = false;
    let releaseLoopReturn: (() => void) | undefined;
    vi.mocked(runAgentLoop).mockImplementationOnce(async (inputs) => {
      loopStarted = true;
      await new Promise<void>((resolve) => {
        inputs.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // What the real loop does on an abort (loop-llm-stream.ts): report an "[aborted]" message
      // live, then return it with the turn's conversation.
      const aborted: SDKMessage = {
        type: "assistant",
        agent_id: inputs.agentId,
        run_id: inputs.runId,
        message: { role: "assistant", content: [{ type: "text", text: "[aborted]" }] },
      };
      inputs.onLoopEvent?.(aborted);
      // Returns only once the test has read the run, so the returned output lands after wait().
      await new Promise<void>((resolve) => {
        releaseLoopReturn = resolve;
      });
      return {
        events: [aborted],
        finalStatus: "completed",
        result: "[aborted]",
        conversation: [{ type: "agentConversationTurn", turn: { steps: [] } }],
      } as never;
    });
    const run = startRunWithOneMcpServer();
    await pollUntil(() => initializeCalls > 0, {
      deadlineMs: 2_000,
      message: "initialize was never called",
    });
    releaseInitialize?.();
    await pollUntil(() => loopStarted, { deadlineMs: 2_000, message: "the loop never started" });

    await run.cancel();
    expect((await run.wait()).status).toBe("cancelled");
    const atWait = await snapshot(run);
    await pollUntil(() => releaseLoopReturn !== undefined, {
      deadlineMs: 2_000,
      message: "the loop never reached its return after the abort",
    });
    releaseLoopReturn?.();

    await pollUntil(() => closes.length > 0, {
      deadlineMs: 2_000,
      message: "the loop never unwound to the finally that closes the owned client",
    });
    const afterUnwind = await snapshot(run);

    expect(afterUnwind).toEqual(atWait);
    expect(JSON.stringify(afterUnwind.messages)).not.toContain("[aborted]");
  });
});
