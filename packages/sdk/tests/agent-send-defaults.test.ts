/**
 * #1020 — `AgentOptions.sendDefaults`: toolResultGuard / pruneToolResults / perToolTimeoutMs
 * applied to every send of an agent, merged per key under the call's own options.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loopInputs: Array<Record<string, unknown>> = [];

vi.mock("../src/internal/agent-loop/loop.js", () => ({
  runAgentLoop: vi.fn(async (inputs: Record<string, unknown>) => {
    loopInputs.push(inputs);
    return { events: [], finalStatus: "completed", result: "ok", conversation: [] };
  }),
}));

const { Agent } = await import("../src/index.js");
const { applyToolResultGuard } = await import("../src/internal/agent-loop/tool-result-guard.js");

let cwd: string;
beforeEach(async () => {
  loopInputs.length = 0;
  cwd = await mkdtemp(join(tmpdir(), "send-defaults-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function create(sendDefaults?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return Agent.create({
    apiKey: "sk-ant-test-key",
    model: { id: "claude-sonnet-4-6" },
    local: { cwd },
    ...(sendDefaults !== undefined ? { sendDefaults } : {}),
    ...extra,
  } as never);
}

describe("AgentOptions.sendDefaults (#1020)", () => {
  it("a plain send gets the default guard, pruning and timeout", async () => {
    const agent = await create({
      toolResultGuard: { delimit: true },
      pruneToolResults: { olderThanRounds: 2 },
      perToolTimeoutMs: 1234,
    });
    await (await agent.send("hi")).wait();
    expect(loopInputs).toHaveLength(1);
    expect(loopInputs[0]?.toolResultGuard).toEqual({ delimit: true });
    expect(loopInputs[0]?.pruneToolResults).toEqual({ olderThanRounds: 2 });
    expect(loopInputs[0]?.perToolTimeoutMs).toBe(1234);
    // The guard the loop receives wraps tool output for the model.
    const [out] = applyToolResultGuard(
      [{ type: "tool_result", toolUseId: "t", content: "data" }],
      loopInputs[0]?.toolResultGuard as never,
    );
    expect((out as { content: string }).content).toContain("<untrusted-tool-output>");
    await agent.dispose?.();
  });

  it("a call's own guard replaces the default; other defaults stay", async () => {
    const agent = await create({
      toolResultGuard: { delimit: true },
      pruneToolResults: { olderThanRounds: 2 },
    });
    await (await agent.send("hi", { toolResultGuard: { redactPii: true } })).wait();
    expect(loopInputs[0]?.toolResultGuard).toEqual({ redactPii: true });
    expect(loopInputs[0]?.pruneToolResults).toEqual({ olderThanRounds: 2 });
  });

  it("an explicit undefined does not remove the default", async () => {
    const agent = await create({ toolResultGuard: { delimit: true } });
    await (await agent.send("hi", { toolResultGuard: undefined })).wait();
    expect(loopInputs[0]?.toolResultGuard).toEqual({ delimit: true });
  });

  it("rejects an invalid default pruneToolResults at create, before any provider call", async () => {
    await expect(create({ pruneToolResults: { olderThanRounds: 0 } })).rejects.toMatchObject({
      code: "invalid_prune_tool_results",
    });
    expect(loopInputs).toHaveLength(0);
  });

  it("an invalid per-send pruning override fails the run, not the default", async () => {
    const agent = await create({ pruneToolResults: { olderThanRounds: 2 } });
    const run = await agent.send("hi", { pruneToolResults: { olderThanRounds: 0 } });
    const result = await run.wait();
    expect(result.status).toBe("error");
    expect(loopInputs).toHaveLength(0);
  });

  it("fork inherits the defaults", async () => {
    const agent = await create({ toolResultGuard: { delimit: true } });
    await agent.fork({ prompt: "sub" } as never);
    expect(loopInputs.at(-1)?.toolResultGuard).toEqual({ delimit: true });
  });

  it("generate sends with the defaults", async () => {
    const { z } = await import("zod");
    const agent = await create({ pruneToolResults: { olderThanRounds: 3 } });
    await agent.generate("q", { schema: z.object({ a: z.string() }) } as never).catch(() => {});
    expect(loopInputs.length).toBeGreaterThan(0);
    expect(loopInputs.at(-1)?.pruneToolResults).toEqual({ olderThanRounds: 3 });
  });

  it("resume keeps persisted defaults and validates an invalid override", async () => {
    const agent = await create({ toolResultGuard: { delimit: true } }, { agentId: "sd-resume" });
    await agent.send("hi").then((r) => r.wait());
    const resumed = await Agent.resume("sd-resume", { local: { cwd }, apiKey: "sk-ant-test-key" });
    await (await resumed.send("again")).wait();
    expect(loopInputs.at(-1)?.toolResultGuard).toEqual({ delimit: true });
    await expect(
      Agent.resume("sd-resume", {
        local: { cwd },
        apiKey: "sk-ant-test-key",
        sendDefaults: { pruneToolResults: { olderThanRounds: 0 } },
      }),
    ).rejects.toMatchObject({ code: "invalid_prune_tool_results" });
  });
});
