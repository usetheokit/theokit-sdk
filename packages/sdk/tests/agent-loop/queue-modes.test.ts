/**
 * B-601 — `SendOptions.queueMode`: `steer` injects into the running turn, `collect` batches the
 * messages sent while a turn runs. Loop-level cases drive the production `runAgentLoop` with a stub
 * `LlmClient`; agent-level cases drive `Agent.send` (offline fixture runtime).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { Agent } from "../../src/agent.js";
import { runAgentLoop } from "../../src/internal/agent-loop/loop.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "../../src/internal/llm/types.js";
import { joinCollected, TurnSteerQueue } from "../../src/internal/local-agent/send-queue.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

/** Every user-text the model was shown, per request. */
function userTexts(request: LlmRequest): string[] {
  const out: string[] = [];
  for (const m of request.messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const part of m.content) if (part.type === "text") out.push(part.text);
  }
  return out;
}

async function drive(client: LlmClient, steer: TurnSteerQueue): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "theokit-queue-"));
  onTestFinished(() => removeTempDirRobust(cwd));
  const hooks = new HooksExecutor(cwd);
  await hooks.initialize(false);
  await runAgentLoop({
    agentId: "q",
    runId: "run-q",
    model: { id: "openai/gpt-4o-mini" },
    userMessage: "start",
    llm: client,
    mcp: new Map(),
    hooks,
    shellCwd: cwd,
    shellSandbox: false,
    steerQueue: steer,
  });
}

describe("steer — loop", () => {
  it("shows a message pushed during a turn to the model's next call", async () => {
    const steer = new TurnSteerQueue();
    const seen: string[][] = [];
    let round = 0;
    const client: LlmClient = {
      name: "stub",
      async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
        seen.push(userTexts(request));
        round += 1;
        if (round === 1) {
          steer.push("actually, use tabs"); // arrives while the first call is in flight
          return {
            stopReason: "tool_use",
            text: "",
            toolCalls: [{ type: "tool_use", id: "c1", name: "shell", input: { command: "true" } }],
          };
        }
        yield { type: "text_delta", text: "ok" };
        return { stopReason: "end_turn", text: "ok", toolCalls: [] };
      },
    };
    await drive(client, steer);
    expect(round).toBe(2);
    expect(seen[0]).not.toContain("actually, use tabs");
    expect(seen[1]).toContain("actually, use tabs");
  });

  it("keeps the run going when the message lands during the final call", async () => {
    const steer = new TurnSteerQueue();
    const seen: string[][] = [];
    let round = 0;
    const client: LlmClient = {
      name: "stub",
      async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
        seen.push(userTexts(request));
        round += 1;
        if (round === 1) steer.push("one more thing");
        yield { type: "text_delta", text: "done" };
        return { stopReason: "end_turn", text: "done", toolCalls: [] };
      },
    };
    await drive(client, steer);
    expect(round).toBe(2);
    expect(seen[1]).toContain("one more thing");
    // The turn has ended, so the queue refuses — the caller falls back to a followup.
    expect(steer.push("too late")).toBe(false);
  });
});

describe("queue helpers", () => {
  it("joins collected messages with a blank line", () => {
    expect(joinCollected(["a", { text: "b" }, "c"])).toBe("a\n\nb\n\nc");
    expect(joinCollected(["only"])).toBe("only");
  });
});

describe("Agent.send queueMode", () => {
  let sends = 0;
  async function makeAgent(): Promise<Awaited<ReturnType<typeof Agent.create>>> {
    sends = 0;
    const cwd = await mkdtemp(join(tmpdir(), "theokit-qm-cwd-"));
    const baseDir = await mkdtemp(join(tmpdir(), "theokit-qm-home-"));
    return Agent.create({
      apiKey: "theo_test_queue_modes",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, sessionDir: baseDir },
      onBeforeSend: () => {
        sends += 1;
      },
    });
  }

  it("collect batches messages sent during a turn into one followup turn", async () => {
    const agent = await makeAgent();
    const first = agent.send("first");
    const b = agent.send("b", { queueMode: "collect" });
    const c = agent.send("c", { queueMode: "collect" });
    const [r1, rb, rc] = await Promise.all([first, b, c]);
    await Promise.all([r1.wait(), rb.wait()]);
    expect(rb).toBe(rc);
    expect(rb).not.toBe(r1);
    expect(sends).toBe(2); // "first", then ONE batched turn for b + c
  });

  it("collect with nothing running is an ordinary send", async () => {
    const agent = await makeAgent();
    const r = await agent.send("solo", { queueMode: "collect" });
    await r.wait();
    expect(sends).toBe(1);
  });

  it("steer with nothing running starts its own turn", async () => {
    const agent = await makeAgent();
    const r = await agent.send("solo", { queueMode: "steer" });
    await r.wait();
    expect(sends).toBe(1);
  });
});
