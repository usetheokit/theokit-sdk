/**
 * B-497: when `thinking-completed` fires, and what `thinkingDurationMs` measures.
 *
 * A UI ends its reasoning block on `thinking-completed` and shows `thinkingDurationMs` as "thought
 * for N s". Both are only right if the update is emitted when reasoning ends (the first text delta
 * after the reasoning deltas), not when the whole turn's stream ends. The scripted client below
 * advances a fake clock between deltas so the two moments are far apart: reasoning spans
 * t=0..1000 ms, the answer t=2500..6000 ms. The first text delta comes 1500 ms after the last
 * reasoning delta, so a duration that ends at the first text delta (2500) is told apart from one
 * that ends at the last reasoning delta (1000).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../../src/internal/agent-loop/loop.js";
import type { LoopContext } from "../../../src/internal/agent-loop/loop-context-init.js";
import {
  type LlmTurnOutput,
  streamLlmTurn,
} from "../../../src/internal/agent-loop/loop-llm-stream.js";
import type { AgentLoopInputs } from "../../../src/internal/agent-loop/types.js";
import type { LlmClient, LlmEvent, LlmFinish } from "../../../src/internal/llm/types.js";
import { makeLoopInputs, makeLoopWorkspace } from "./_helpers/make-inputs.js";

const START_MS = 1_000_000;

/** Each scripted delta carries the fake-clock time at which the provider delivers it. */
type TimedEvent = { atMs: number; event: LlmEvent };

const REASON_THEN_ANSWER: TimedEvent[] = [
  { atMs: 0, event: { type: "reasoning_delta", text: "step 1: " } },
  { atMs: 500, event: { type: "reasoning_delta", text: "compute 17*23" } },
  { atMs: 1000, event: { type: "reasoning_delta", text: " = 391" } },
  { atMs: 2500, event: { type: "text_delta", text: "The answer " } },
  { atMs: 4000, event: { type: "text_delta", text: "is " } },
  { atMs: 6000, event: { type: "text_delta", text: "391." } },
];

const REASONING_SPAN_MS = 1000;

function scriptedLlm(script: TimedEvent[]): LlmClient {
  return {
    name: "openrouter",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      for (const { atMs, event } of script) {
        vi.setSystemTime(START_MS + atMs);
        yield event;
      }
      return { stopReason: "end_turn", text: "", toolCalls: [] };
    },
  };
}

type Update = { type: string; text?: string; thinkingDurationMs?: number };

async function runScripted(
  script: TimedEvent[],
  onUpdate?: (update: Update) => void,
): Promise<{ updates: Update[]; events: LoopContext["events"]; output: LlmTurnOutput }> {
  const updates: Update[] = [];
  const inputs = makeLoopInputs({
    agentId: "agent-test",
    runId: "run-test",
    model: { id: "deepseek/deepseek-r1-0528", params: [{ id: "thinking", value: "high" }] },
    llm: scriptedLlm(script),
    onDelta: (payload: { update: Update }) => {
      updates.push(payload.update);
      onUpdate?.(payload.update);
    },
  } as Partial<AgentLoopInputs>);
  const ctx = {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    events: [],
    memorySystemPromptAdditions: undefined,
  } as unknown as LoopContext;
  const output = await streamLlmTurn(inputs, ctx);
  return { updates, events: ctx.events, output };
}

/**
 * Round 1 reasons on the fake clock, then the clock moves 2000 ms while the provider would be
 * streaming the tool call's arguments (the clients buffer those without an event), and the round
 * finishes with a `shell` call. Round 2 answers with text and no reasoning.
 */
const TOOL_ARGUMENT_GAP_MS = 2000;

function reasonThenToolLlm(): LlmClient {
  let round = 0;
  return {
    name: "openrouter",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      round += 1;
      if (round === 1) {
        const reasoning = REASON_THEN_ANSWER.filter((e) => e.event.type === "reasoning_delta");
        for (const { atMs, event } of reasoning) {
          vi.setSystemTime(START_MS + atMs);
          yield event;
        }
        vi.setSystemTime(START_MS + REASONING_SPAN_MS + TOOL_ARGUMENT_GAP_MS);
        return {
          stopReason: "tool_use",
          text: "",
          toolCalls: [
            { type: "tool_use", id: "call_1", name: "shell", input: { command: "echo hi" } },
          ],
        };
      }
      yield { type: "text_delta", text: "Done." };
      return { stopReason: "end_turn", text: "Done.", toolCalls: [] };
    },
  };
}

describe("B-497: thinking-completed timing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Control: passes before and after B-497. If this fails, the harness is broken and the tests below
  // are not evidence of anything.
  it("test_emits_one_thinking_completed_per_reasoning_block", async () => {
    const { updates } = await runScripted(REASON_THEN_ANSWER);
    expect(updates.filter((u) => u.type === "thinking-completed")).toHaveLength(1);
    // The fake clock is the one the SDK reads: a 1000 ms reasoning span cannot report 0.
    const completed = updates.find((u) => u.type === "thinking-completed");
    expect(completed?.thinkingDurationMs).toBeGreaterThan(0);
  });

  it("test_thinking_completed_arrives_before_first_text_delta", async () => {
    const types = (await runScripted(REASON_THEN_ANSWER)).updates.map((u) => u.type);
    expect(types).toContain("thinking-completed");
    expect(types).toContain("text-delta");
    expect(types.indexOf("thinking-completed")).toBeLessThan(types.indexOf("text-delta"));
  });

  // The clock is fake, so the span is exact: last reasoning delta minus first, nothing else.
  it("test_thinking_duration_is_the_reasoning_span", async () => {
    const { updates } = await runScripted(REASON_THEN_ANSWER);
    const completed = updates.find((u) => u.type === "thinking-completed");
    expect(completed?.thinkingDurationMs).toBe(REASONING_SPAN_MS);
  });

  it("test_thinking_sdkmessage_duration_is_the_reasoning_span", async () => {
    const { events } = await runScripted(REASON_THEN_ANSWER);
    const thinking = events.find((e) => e.type === "thinking") as
      | { thinking_duration_ms?: number }
      | undefined;
    expect(thinking?.thinking_duration_ms).toBe(REASONING_SPAN_MS);
  });

  // A reasoning delta after the answer started is shown and replayed, but the close was already
  // sent: no second close, and the duration the consumer saw stays the one it keeps. The late
  // signature-only delta must still reach the returned block, or the replayed block is rejected.
  it("test_late_reasoning_emits_no_second_thinking_completed", async () => {
    const script: TimedEvent[] = [
      ...REASON_THEN_ANSWER.slice(0, 4),
      { atMs: 3000, event: { type: "reasoning_delta", text: " (checked)" } },
      { atMs: 3500, event: { type: "reasoning_delta", text: "", signature: "S" } },
    ];
    const { updates, events, output } = await runScripted(script);
    const completed = updates.filter((u) => u.type === "thinking-completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.thinkingDurationMs).toBe(REASONING_SPAN_MS);
    // The replayed message carries the duration the live consumer was told, not a wider one.
    const thinking = events.find((e) => e.type === "thinking") as
      | { thinking_duration_ms?: number }
      | undefined;
    expect(thinking?.thinking_duration_ms).toBe(REASONING_SPAN_MS);
    expect(updates.filter((u) => u.type === "thinking-delta").map((u) => u.text)).toContain(
      " (checked)",
    );
    expect(output.thinking?.text).toContain(" (checked)");
    expect(output.thinking?.signature).toBe("S");
    expect(output.text).not.toContain("checked");
    expect(updates).toHaveLength(script.length + 1);
  });

  it("test_thinking_completed_precedes_tool_call_started", async () => {
    const { cwd, hooks } = await makeLoopWorkspace("theokit-thinking-timing-");
    const updates: Update[] = [];
    await runAgentLoop(
      makeLoopInputs({
        model: { id: "deepseek/deepseek-r1-0528", params: [{ id: "thinking", value: "high" }] },
        llm: reasonThenToolLlm(),
        hooks,
        shellCwd: cwd,
        onDelta: (payload: { update: Update }) => {
          updates.push(payload.update);
        },
      } as Partial<AgentLoopInputs>),
    );
    const types = updates.map((u) => u.type);
    expect(types).toContain("tool-call-started");
    expect(types.indexOf("thinking-completed")).toBeLessThan(types.indexOf("tool-call-started"));
    const completed = updates.filter((u) => u.type === "thinking-completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.thinkingDurationMs).toBe(REASONING_SPAN_MS);
  }, 20_000);

  // The close goes through the same guarded callback as every other update: a listener that
  // throws on it cannot cost the consumer the answer.
  it("test_throwing_listener_on_close_still_streams_text", async () => {
    const { updates, output } = await runScripted(REASON_THEN_ANSWER, (update) => {
      if (update.type === "thinking-completed") throw new Error("listener failed on close");
    });
    expect(updates.filter((u) => u.type === "text-delta").map((u) => u.text)).toEqual([
      "The answer ",
      "is ",
      "391.",
    ]);
    expect(output.text).toBe("The answer is 391.");
    expect(output.errored).toBe(false);
  });

  it("test_in_band_error_after_reasoning_closes_once", async () => {
    const script: TimedEvent[] = [
      ...REASON_THEN_ANSWER.slice(0, 3),
      { atMs: 4000, event: { type: "error", message: "provider failed mid-turn" } },
    ];
    const { updates, output } = await runScripted(script);
    const completed = updates.filter((u) => u.type === "thinking-completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.thinkingDurationMs).toBe(REASONING_SPAN_MS);
    expect(output.errored).toBe(true);
  });
});
