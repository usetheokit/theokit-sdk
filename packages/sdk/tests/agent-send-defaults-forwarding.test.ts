/**
 * `AgentOptions.sendDefaults` reaching the agent loop: pruning, per-tool timeout, resume
 * validation, run-boundary validation, and fork inheritance. Observes `runAgentLoop` inputs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTempCwd } from "./helpers/temp-workspace.js";

const loopInputs: Array<Record<string, unknown>> = [];

vi.mock("../src/internal/agent-loop/loop.js", () => ({
  runAgentLoop: vi.fn(async (inputs: Record<string, unknown>) => {
    loopInputs.push(inputs);
    return { events: [], finalStatus: "completed", result: "ok", conversation: [] };
  }),
}));

const { Agent } = await import("../src/index.js");

useTempCwd();

const base = { apiKey: "sk-ant-test-key", model: { id: "claude-sonnet-4-6" } };
const defaults = {
  pruneToolResults: { olderThanRounds: 2 },
  perToolTimeoutMs: 1234,
};

describe("sendDefaults forwarding", () => {
  beforeEach(() => {
    loopInputs.length = 0;
  });

  it("forwards pruneToolResults and perToolTimeoutMs on a plain send", async () => {
    const agent = await Agent.create({ ...base, sendDefaults: defaults });
    await (await agent.send("go")).wait();
    expect(loopInputs).toHaveLength(1);
    expect(loopInputs[0]?.pruneToolResults).toEqual({ olderThanRounds: 2 });
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(1234);
    agent.dispose();
  });

  it("a per-call value wins per key and others keep the default", async () => {
    const agent = await Agent.create({ ...base, sendDefaults: defaults });
    await (await agent.send("go", { perToolTimeoutMs: 99 })).wait();
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(99);
    expect(loopInputs[0]?.pruneToolResults).toEqual({ olderThanRounds: 2 });
    agent.dispose();
  });

  it("an invalid per-call prune value still rejects at the run boundary", async () => {
    const agent = await Agent.create({ ...base, sendDefaults: defaults });
    const result = await (
      await agent.send("go", { pruneToolResults: { olderThanRounds: 0 } })
    ).wait();
    expect(result.status).toBe("error");
    expect(result.error?.cause).toMatchObject({ code: "invalid_prune_tool_results" });
    expect(loopInputs).toHaveLength(0);
    agent.dispose();
  });

  it("fork inherits the parent's sendDefaults", async () => {
    const agent = await Agent.create({ ...base, sendDefaults: defaults });
    await agent.fork?.({ prompt: "hi", allowedTools: new Set<string>() });
    expect(loopInputs).toHaveLength(1);
    expect(loopInputs[0]?.pruneToolResults).toEqual({ olderThanRounds: 2 });
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(1234);
    agent.dispose();
  });

  it("Agent.resume applies persisted defaults and rejects an invalid override", async () => {
    const agent = await Agent.create({ ...base, agentId: "sd-resume", sendDefaults: defaults });
    await expect(
      Agent.resume("sd-resume", { sendDefaults: { pruneToolResults: { olderThanRounds: 0 } } }),
    ).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
    const resumed = await Agent.resume("sd-resume", {});
    await (await resumed.send("go")).wait();
    expect(loopInputs.at(-1)?.pruneToolResults).toEqual({ olderThanRounds: 2 });
    resumed.dispose();
    agent.dispose();
  });
});
