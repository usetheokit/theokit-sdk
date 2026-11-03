/**
 * B-504: a run cancelled while its first MCP server initializes must not go on to initialize the
 * others. `initializeMcp` awaits `initialize()` for every configured server in turn, and the real
 * `initialize()` spawns a child process, so a loop that never reads `terminated` keeps spawning
 * servers for a run the caller already stopped. The one-server tests in
 * `cancel-during-initialize.test.ts` cannot observe it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pollUntil } from "../helpers/poll-until.js";

const closes: string[] = [];
const initialized: string[] = [];
/** Every pending `initialize()`, so none is left hanging when the loop calls a second one. */
const pendingInitializes: Array<() => void> = [];
/** When set, `initialize()` of the server with this name rejects at once. */
let failingServer: string | undefined;

vi.mock("../../src/internal/mcp/client.js", () => ({
  createMcpClient: (name: string) => ({
    name,
    initialize: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          initialized.push(name);
          if (name === failingServer) reject(new Error(`${name} handshake refused`));
          else pendingInitializes.push(resolve);
        }),
    ),
    close: vi.fn(async () => {
      closes.push(name);
    }),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({})),
  }),
}));

vi.mock("../../src/internal/agent-loop/loop.js", () => ({
  runAgentLoop: vi.fn(async () => ({
    events: [],
    finalStatus: "completed",
    result: "ok",
    conversation: [],
  })),
}));

const { createRealLocalRun } = await import("../../src/internal/local-agent/real-local-run.js");

function startRunWithTwoMcpServers() {
  return createRealLocalRun({
    agentId: "agent-cancel-during-init-many",
    model: { id: "claude-sonnet-4-6" },
    message: "hello",
    agentOptions: {
      apiKey: "sk-ant-test-key",
      mcpServers: {
        first: { command: "node", args: ["first-server.js"] },
        second: { command: "node", args: ["second-server.js"] },
      },
    },
    sendOptions: {},
    workspaceCwd: process.cwd(),
    hooks: {} as never,
  } as never);
}

/** Releases every pending initialize() until the run has closed both clients it owns. */
async function releaseUntilBothClosed(): Promise<void> {
  await pollUntil(
    () => {
      while (pendingInitializes.length > 0) pendingInitializes.shift()?.();
      return closes.length === 2;
    },
    { deadlineMs: 2_000, message: () => `owned clients closed: ${JSON.stringify(closes)}` },
  );
}

describe("a run with two MCP servers cancelled while the first initializes", () => {
  beforeEach(() => {
    closes.length = 0;
    initialized.length = 0;
    pendingInitializes.length = 0;
    failingServer = undefined;
  });

  it("does_not_initialize_the_second_server", async () => {
    const run = startRunWithTwoMcpServers();

    await pollUntil(() => initialized.length > 0, {
      deadlineMs: 2_000,
      message: "initialize was never called",
    });
    await run.cancel();
    await releaseUntilBothClosed();

    expect([...closes].sort()).toEqual(["first", "second"]);
    expect(initialized).toEqual(["first"]);
    expect((await run.wait()).status).toBe("cancelled");
  });

  it("initializes_every_server_when_not_cancelled", async () => {
    const run = startRunWithTwoMcpServers();

    await releaseUntilBothClosed();

    expect(initialized).toEqual(["first", "second"]);
    expect((await run.wait()).status).toBe("completed");
  });

  it("keeps_initializing_after_a_server_fails_when_not_cancelled", async () => {
    failingServer = "first";
    const run = startRunWithTwoMcpServers();

    await releaseUntilBothClosed();

    // A failure is not a cancel: the loop goes on to the next server and the turn still runs.
    expect(initialized).toEqual(["first", "second"]);
    expect((await run.wait()).status).toBe("completed");
  });
});
