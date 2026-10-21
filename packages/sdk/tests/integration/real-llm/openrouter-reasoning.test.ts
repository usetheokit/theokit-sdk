/**
 * issue #47 — OpenRouter reasoning scenario (real-LLM).
 *
 * Env-gated by OPENROUTER_API_KEY. Proves the end-to-end reasoning path the fix exists for:
 * a `thinking` param on `ModelSelection.params` makes the SDK request reasoning from OpenRouter
 * (`reasoning: { effort }`), and the streamed `delta.reasoning` surfaces as `thinking-delta`
 * InteractionUpdates (live, via `onDelta`) plus `thinking` SDKMessages (via `Run.stream`) — on a
 * separate channel from the visible answer.
 *
 * Per `.claude/rules/real-llm-validation.md` this is the committable, repeatable evidence that the
 * unit-tested wiring actually produces reasoning against a real reasoning model (deepseek/deepseek-r1-0528).
 */

import { describe, expect, it } from "vitest";

import type { InteractionUpdate, Run } from "../../../src/index.js";
import { Agent } from "../../../src/index.js";
import { useTempCwd } from "../../helpers/temp-workspace.js";
import { resolveRealLlmEnv } from "./_helpers/real-llm-env.js";

// Agent.create defaults its workspace to process.cwd(), which during a test run is the
// package itself — this file created agents without saying where, and the state landed in
// packages/sdk/.theokit/. See useTempCwd's docblock for the 540 MB that bought.
useTempCwd();

const env = resolveRealLlmEnv("openrouter", { model: "deepseek/deepseek-r1-0528" });

/** Drain the run stream, separating reasoning (`thinking`) messages from the visible answer. */
async function drainRun(run: Run): Promise<{ thinkingMessages: number; answerText: string }> {
  let thinkingMessages = 0;
  let answerText = "";
  for await (const event of run.stream()) {
    if (event.type === "thinking") {
      thinkingMessages += 1;
    } else if (event.type === "assistant") {
      answerText += event.message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    }
  }
  return { thinkingMessages, answerText };
}

type TimedUpdate = { update: InteractionUpdate; at: number };

/**
 * B-497: where the FIRST `thinking-completed` sits relative to the answer, and the span of the
 * reasoning deltas it closes. Sequence numbers are indexes into the `onDelta` timeline; the span
 * uses the test's own clock on that same callback, so network latency before the first delta does
 * not enter it. Only deltas before the first close count, so a later reasoning turn cannot widen it.
 */
function firstCloseTiming(timeline: readonly TimedUpdate[]): {
  firstCompletedSeq: number;
  firstTextDeltaSeq: number;
  firstCompletedDurationMs: number;
  thinkingSpanMs: number;
} {
  const firstCompletedSeq = timeline.findIndex((t) => t.update.type === "thinking-completed");
  const firstTextDeltaSeq = timeline.findIndex((t) => t.update.type === "text-delta");
  const closing = timeline[firstCompletedSeq]?.update;
  const firstCompletedDurationMs =
    closing?.type === "thinking-completed" ? closing.thinkingDurationMs : -1;
  const reasoningTimes = timeline
    .slice(0, Math.max(firstCompletedSeq, 0))
    .filter((t) => t.update.type === "thinking-delta")
    .map((t) => t.at);
  const thinkingSpanMs =
    reasoningTimes.length > 0 ? Math.max(...reasoningTimes) - Math.min(...reasoningTimes) : -1;
  return { firstCompletedSeq, firstTextDeltaSeq, firstCompletedDurationMs, thinkingSpanMs };
}

describe.skipIf(env.shouldSkip)(`real-llm: openrouter reasoning (${env.provider})`, () => {
  it("surfaces reasoning as thinking-delta + thinking messages, separate from the answer", async () => {
    const agent = await Agent.create({
      apiKey: env.apiKey,
      model: { id: env.model, params: [{ id: "thinking", value: "high" }] },
      // deepseek/deepseek-r1-0528 is an OpenRouter slug — route the chat capability to OpenRouter so the full
      // `deepseek/deepseek-r1-0528` id is sent (prefix inference would otherwise pick a bare provider).
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    });
    try {
      let thinkingDeltas = 0;
      let reasoningText = "";
      // issue #48: the completion half of the channel — a UI closes its reasoning block on this.
      let thinkingCompleted = 0;
      let lastCompletedDurationMs: number | undefined;
      let lastThinkingDeltaSeq = -1;
      let completedSeq = -1;
      let seq = 0;
      const timeline: TimedUpdate[] = [];
      const run = await agent.send("What is 17 * 23? Reason step by step, then answer.", {
        onDelta: ({ update }) => {
          timeline.push({ update, at: Date.now() });
          if (update.type === "thinking-delta") {
            thinkingDeltas += 1;
            reasoningText += update.text;
            lastThinkingDeltaSeq = seq;
          } else if (update.type === "thinking-completed") {
            thinkingCompleted += 1;
            lastCompletedDurationMs = update.thinkingDurationMs;
            completedSeq = seq;
          }
          seq += 1;
        },
      });
      const { thinkingMessages, answerText } = await drainRun(run);
      await run.wait();

      // Reasoning was actually produced and surfaced on its own channel.
      expect(thinkingDeltas).toBeGreaterThan(0);
      expect(thinkingMessages).toBeGreaterThan(0);
      expect(reasoningText.length).toBeGreaterThan(0);
      // issue #48: one `thinking-completed` per reasoning block (a real run may reason across more
      // than one LLM turn, so >= 1), matching the count of replayed `thinking` messages one-for-one.
      // The last one arrives after the last thinking-delta with a non-negative measured duration.
      expect(thinkingCompleted).toBeGreaterThanOrEqual(1);
      expect(thinkingCompleted).toBe(thinkingMessages);
      expect(completedSeq).toBeGreaterThan(lastThinkingDeltaSeq);
      expect(typeof lastCompletedDurationMs).toBe("number");
      expect(lastCompletedDurationMs).toBeGreaterThanOrEqual(0);
      // B-497: the close ends the reasoning block before the answer starts, and its duration is
      // the span of the reasoning deltas it closes, within 500 ms of slack for delivery jitter.
      const { firstCompletedSeq, firstTextDeltaSeq, firstCompletedDurationMs, thinkingSpanMs } =
        firstCloseTiming(timeline);
      expect(firstTextDeltaSeq).toBeGreaterThan(-1);
      expect(firstCompletedSeq).toBeLessThan(firstTextDeltaSeq);
      expect(Math.abs(firstCompletedDurationMs - thinkingSpanMs)).toBeLessThanOrEqual(500);
      // The visible answer is non-empty and does NOT simply equal the chain-of-thought.
      expect(answerText.length).toBeGreaterThan(0);
      expect(answerText).not.toBe(reasoningText);
    } finally {
      await agent.dispose();
    }
  }, 90_000);
});
