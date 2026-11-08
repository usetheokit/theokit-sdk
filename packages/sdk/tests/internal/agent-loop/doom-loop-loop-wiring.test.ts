/**
 * Integration test — doom-loop guard wired into the REAL agent loop (T2.1).
 *
 * Drives `runAgentLoop` end-to-end with a mock `LlmClient` that emits the SAME `tool_use` every turn
 * plus a custom tool that SUCCEEDS (so the consecutive-tool-error cap never trips before the guard).
 * Proves the actual `inspectDoomLoop` seam: the run stops with `RunResult.stoppedByDoomLoop`, the
 * resumable stop message is emitted as the final assistant text, custom thresholds take effect, and
 * `doomLoop: false` disables the guard. Mirrors `strip-think-wiring.test.ts` — the mock LLM is the
 * accepted seam (the full loop is driven without a live provider).
 */
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../../../src/internal/agent-loop/loop.js";
import type { AgentLoopInputs } from "../../../src/internal/agent-loop/types.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmToolCallPart,
} from "../../../src/internal/llm/types.js";
import { makeLoopInputs } from "./_helpers/make-inputs.js";

/** Stateless mock: returns the identical `tool_use` on EVERY turn — the doom-loop trigger. */
function repeatingToolLlm(name: string, input: Record<string, unknown>): LlmClient {
  return {
    name: "mock",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      yield { type: "text_delta", text: "" };
      const call: LlmToolCallPart = {
        type: "tool_use",
        id: "call-1",
        name,
        input,
      };
      return {
        stopReason: "tool_use",
        text: "",
        toolCalls: [call],
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

const makeInputs = (
  llm: LlmClient,
  opts: {
    maxIterations: number;
    doomLoop?: false | { softThreshold?: number; hardThreshold?: number };
  },
): AgentLoopInputs =>
  makeLoopInputs({
    agentId: "doom-loop-wiring-test",
    userMessage: "please loop",
    llm,
    maxIterations: opts.maxIterations,
    // A custom tool that succeeds — matches the tool the mock calls, so dispatch never errors and the
    // consecutive-tool-error cap (3) cannot pre-empt the doom-loop hard threshold (5).
    customTools: [
      {
        name: "probe",
        description: "always-succeeds probe tool",
        inputSchema: { type: "object" },
        handler: () => "ok",
      },
    ],
    ...(opts.doomLoop !== undefined ? { doomLoop: opts.doomLoop } : {}),
  });

describe("doom-loop guard wired into runAgentLoop (T2.1)", () => {
  it("test_identical_calls_hit_hard_threshold_stops_run", async () => {
    const output = await runAgentLoop(
      makeInputs(repeatingToolLlm("probe", { path: "a" }), {
        maxIterations: 20,
      }),
    );
    expect(output.stoppedByDoomLoop).toBe(true);
    // A CONTROLLED stop — not an error, and not a silent iteration-ceiling truncation (20 > 5).
    expect(output.finalStatus).toBe("finished");
    expect(output.stoppedAtIterationLimit).toBeUndefined();
  });

  it("test_stop_injects_resumable_message_naming_the_tool", async () => {
    const output = await runAgentLoop(
      makeInputs(repeatingToolLlm("probe", { path: "a" }), {
        maxIterations: 20,
      }),
    );
    // The final assistant text is the guard's stop message — resumable and names the offending tool.
    expect(output.result).toContain("probe");
    expect(output.result.toLowerCase()).toContain("consecutive");
  });

  it("test_custom_hard_threshold_stops_earlier", async () => {
    const output = await runAgentLoop(
      makeInputs(repeatingToolLlm("probe", { path: "a" }), {
        maxIterations: 20,
        doomLoop: { hardThreshold: 2 },
      }),
    );
    expect(output.stoppedByDoomLoop).toBe(true);
  });

  it("test_doomLoop_false_disables_guard_runs_to_ceiling", async () => {
    const output = await runAgentLoop(
      makeInputs(repeatingToolLlm("probe", { path: "a" }), {
        maxIterations: 4,
        doomLoop: false,
      }),
    );
    // Guard off → identical repeats are NOT stopped; the run truncates at the iteration ceiling.
    expect(output.stoppedByDoomLoop).toBeUndefined();
    expect(output.stoppedAtIterationLimit).toBe(true);
  });

  it("test_argument_churn_without_progress_stops_run", async () => {
    let turn = 0;
    const churnLlm: LlmClient = {
      name: "mock",
      async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
        yield { type: "text_delta", text: "" };
        turn += 1;
        const call: LlmToolCallPart = {
          type: "tool_use",
          id: `call-${turn}`,
          name: "probe",
          input: { path: `file-${turn}` },
        };
        return {
          stopReason: "tool_use",
          text: "",
          toolCalls: [call],
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const output = await runAgentLoop(makeInputs(churnLlm, { maxIterations: 20 }));
    expect(output.stoppedByDoomLoop).toBe(true);
    expect(output.result.toLowerCase()).toContain("argument churn");
    expect(turn).toBeLessThan(20);
  });
});
