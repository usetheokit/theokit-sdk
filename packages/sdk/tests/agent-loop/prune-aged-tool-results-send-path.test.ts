/**
 * B-564 — the forwarding seam of `SendOptions.pruneToolResults`.
 *
 * The loop-level cases in `prune-aged-tool-results.test.ts` hand the option straight to the loop
 * inputs, and the send-boundary case there only sends INVALID values, which throw in
 * `validatePruneToolResults` before the forward runs. So deleting the forward in
 * `toolResultPolicyInputs` left every test green. This file observes what `runAgentLoop` receives
 * from `createRealLocalRun` for a VALID option, the same seam the memory-provider wiring test uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loopInputs: Array<Record<string, unknown>> = [];

vi.mock("../../src/internal/agent-loop/loop.js", () => ({
  runAgentLoop: vi.fn(async (inputs: Record<string, unknown>) => {
    loopInputs.push(inputs);
    return { events: [], finalStatus: "completed", result: "ok", conversation: [] };
  }),
}));

const { createRealLocalRun } = await import("../../src/internal/local-agent/real-local-run.js");

async function sendWith(sendOptions: Record<string, unknown>): Promise<void> {
  const run = createRealLocalRun({
    agentId: "prune-send-path",
    model: { id: "claude-sonnet-4-6" },
    message: "hello",
    agentOptions: { apiKey: "sk-ant-test-key" },
    sendOptions,
    workspaceCwd: process.cwd(),
    hooks: {} as never,
  } as never);
  await run.wait();
}

describe("SendOptions.pruneToolResults reaches the agent loop (B-564)", () => {
  beforeEach(() => {
    loopInputs.length = 0;
  });

  it("a valid option is forwarded onto the loop inputs unchanged", async () => {
    await sendWith({ pruneToolResults: { olderThanRounds: 2 } });

    expect(loopInputs, "the loop was never reached; this test proves nothing").toHaveLength(1);
    expect(
      loopInputs[0]?.pruneToolResults,
      "toolResultPolicyInputs dropped the option; send() would silently not prune",
    ).toEqual({ olderThanRounds: 2 });
  });

  it("an absent option stays absent on the loop inputs", async () => {
    await sendWith({});

    expect(loopInputs).toHaveLength(1);
    expect(loopInputs[0]).not.toHaveProperty("pruneToolResults");
  });
});
