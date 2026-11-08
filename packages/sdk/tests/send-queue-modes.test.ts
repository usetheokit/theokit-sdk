/**
 * B-601 — `SendOptions.queueMode`: `steer` injects into the running turn, `collect` batches.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { continueOrTerminate, injectSteering } from "../src/internal/agent-loop/loop.js";
import type { LoopContext } from "../src/internal/agent-loop/loop-context-init.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../src/internal/session/agent-session.js";
import { makeLoopInputs } from "./internal/agent-loop/_helpers/make-inputs.js";

const MODEL = { id: "openai/gpt-4o-mini" };

describe("steer: the loop takes steered messages", () => {
  const ctxOf = (): LoopContext =>
    ({ messages: [], nudgeAttempts: 0, stopFeedbackAttempts: 0 }) as unknown as LoopContext;

  it("appends them as user messages before the next model call", () => {
    const ctx = ctxOf();
    const inbox = ["actually use TypeScript"];
    const inputs = makeLoopInputs({ drainSteering: () => inbox.splice(0) });
    expect(injectSteering(inputs, ctx)).toBe(true);
    expect(ctx.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "actually use TypeScript" }] },
    ]);
    expect(injectSteering(inputs, ctx)).toBe(false);
  });

  it("keeps the turn going instead of finishing when a steer arrived late", async () => {
    const ctx = ctxOf();
    const inbox = ["one more thing"];
    const inputs = makeLoopInputs({ drainSteering: () => inbox.splice(0) });
    const out = await continueOrTerminate(inputs, ctx, {
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
    } as never);
    expect(out).toBe("continue");
    expect(ctx.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "one more thing" }],
    });
  });
});

describe("Agent.send queueMode", () => {
  let root: string;
  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-queue-mode-"));
  });
  afterEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await rm(root, { recursive: true, force: true });
  });

  /** An agent whose first turn parks inside the send lock until `release()`. */
  async function parkedAgent() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let calls = 0;
    const agent = await Agent.create({
      apiKey: "theo_test_queue_modes",
      model: MODEL,
      local: { cwd: root },
      onBeforeSend: async () => {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
      },
    });
    return { agent, release, started, calls: () => calls };
  }

  it("collect batches mid-turn sends into one followup turn", async () => {
    const { agent, release, started, calls } = await parkedAgent();
    const first = agent.send("first");
    await started;
    const a = agent.send("alpha", { queueMode: "collect" });
    const b = agent.send("beta", { queueMode: "collect" });
    release();
    const [firstRun, runA, runB] = await Promise.all([first, a, b]);
    expect(runA).toBe(runB);
    expect(runA).not.toBe(firstRun);
    expect(calls()).toBe(2); // first turn + ONE batched turn, not three
    await agent.dispose();
  });

  it("steer resolves with the running turn's Run and starts no extra turn", async () => {
    const { agent, release, started, calls } = await parkedAgent();
    const first = agent.send("first");
    await started;
    const steered = agent.send("change course", { queueMode: "steer" });
    release();
    const [firstRun, steerRun] = await Promise.all([first, steered]);
    expect(steerRun).toBe(firstRun);
    await new Promise((r) => setTimeout(r, 20));
    // Fixture runs never take the inbox, so the leftover rides a followup turn rather than vanishing.
    expect(calls()).toBe(2);
    await agent.dispose();
  });

  it("with no turn running, steer and collect are ordinary sends", async () => {
    const { agent, release, calls } = await parkedAgent();
    release();
    await agent.send("x", { queueMode: "steer" });
    await agent.send("y", { queueMode: "collect" });
    expect(calls()).toBe(2);
    await agent.dispose();
  });
});
