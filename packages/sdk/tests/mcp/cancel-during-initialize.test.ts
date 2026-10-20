/**
 * A run cancelled while its MCP servers initialize must not start a turn, and must still close
 * the MCP clients it owns.
 *
 * `driveLoop` checks `terminated` once, then awaits `initializeMcp`, then runs the loop. A cancel
 * that lands during that await used to start a turn anyway: hooks ran and a turn was built for a
 * run the caller had already stopped. The guard sits inside the `try` of `executeAgentLoop`, so the
 * `finally` that releases run-owned MCP clients still runs; this test watches both halves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pollUntil } from "../helpers/poll-until.js";

const closes: string[] = [];
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

describe("a run cancelled while its MCP servers initialize", () => {
  beforeEach(() => {
    closes.length = 0;
    initializeCalls = 0;
    releaseInitialize = undefined;
    vi.mocked(runAgentLoop).mockClear();
  });

  it("starts no loop turn, and still closes the MCP client it owns", async () => {
    const run = createRealLocalRun({
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
});
