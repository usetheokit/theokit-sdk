/**
 * B-564 — opt-in pruning of aged tool results (`SendOptions.pruneToolResults`).
 *
 * The loop resends every tool result of a run on every later LLM call. DISCOVER measured it through
 * the real `runAgentLoop`: two shell rounds each printing 4000 bytes, then a text round, record
 * requests of 57, 4282 and 8507 bytes (`sdk-prune-aged-tool-results-measurement.txt:1`). Those
 * numbers are this file's oracle for the option-off path, and the 4800-byte budget is the oracle
 * for the option-on path.
 *
 * The loop-level cases drive the production loop and record each request AT REQUEST TIME: the
 * request's `messages` is the live transcript array, so serializing it after the run would show
 * every call as the final state.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ConfigurationError } from "../../src/errors.js";
import {
  pruneToolResultsForRequest,
  validatePruneToolResults,
} from "../../src/internal/agent-loop/prune-tool-results.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmMessage,
  LlmRequest,
  LlmToolResultPart,
} from "../../src/internal/llm/types.js";
import { createRealLocalRun } from "../../src/internal/local-agent/real-local-run.js";
import { driveLoop } from "../helpers/agent-loop-driver.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

const PRINT_4000_BYTES = "head -c 4000 /dev/zero | tr '\\0' a";

/** Two shell rounds that each print 4000 bytes, then a text close: the DISCOVER script. */
function twoShellRoundsThenText(recorded: string[], seen: LlmRequest[]): LlmClient {
  let call = 0;
  return {
    name: "stub",
    async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
      call += 1;
      recorded.push(JSON.stringify(request.messages));
      seen.push({ ...request, messages: structuredClone(request.messages) });
      yield { type: "text_delta", text: "" };
      if (call <= 2) {
        return {
          stopReason: "tool_use",
          text: "",
          toolCalls: [
            {
              type: "tool_use",
              id: `call-${call}`,
              name: "shell",
              input: { command: PRINT_4000_BYTES },
            },
          ],
        };
      }
      return { stopReason: "end_turn", text: "done", toolCalls: [] };
    },
  };
}

function toolResultsOf(message: LlmMessage | undefined): LlmToolResultPart[] {
  return (message?.content ?? []).filter(
    (part): part is LlmToolResultPart => part.type === "tool_result",
  );
}

describe("pruneToolResults through the real loop (B-564)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-prune-"));
    const dir = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(dir);
    });
  });

  async function run(pruneToolResults?: { olderThanRounds: number }) {
    const recorded: string[] = [];
    const seen: LlmRequest[] = [];
    const { result } = await driveLoop(cwd, {
      llm: twoShellRoundsThenText(recorded, seen),
      userMessage: "go",
      ...(pruneToolResults !== undefined ? { pruneToolResults } : {}),
    });
    return { recorded, seen, result };
  }

  it("test_option_off_sends_the_measured_57_4282_and_8507_bytes", async () => {
    const { recorded } = await run();

    expect(recorded.slice(0, 3).map((json) => json.length)).toEqual([57, 4282, 8507]);
  });

  it("test_aged_round_1_result_is_a_stub_at_call_3_and_round_2_stays_whole", async () => {
    const { seen } = await run({ olderThanRounds: 1 });
    const call3 = seen[2]?.messages ?? [];

    const round1 = toolResultsOf(call3[2]);
    const round2 = toolResultsOf(call3[4]);
    expect(round1).toEqual([
      {
        type: "tool_result",
        toolUseId: "call-1",
        content: "[tool result pruned: older than 1 rounds]",
      },
    ]);
    expect(round2[0]?.toolUseId).toBe("call-2");
    expect(round2[0]?.content).toBe("a".repeat(4000));
  });

  it("test_call_2_is_unchanged_because_round_1_is_not_yet_aged", async () => {
    const { recorded } = await run({ olderThanRounds: 1 });

    expect(recorded[1]?.length).toBe(4282);
  });

  it("test_round_3_request_is_at_most_4800_bytes_with_olderThanRounds_1", async () => {
    const { recorded } = await run({ olderThanRounds: 1 });

    expect(recorded[2]?.length).toBeLessThanOrEqual(4800);
  });

  it("test_the_transcript_keeps_every_full_result_while_requests_are_pruned", async () => {
    const { result } = await run({ olderThanRounds: 1 });
    const results = (result.conversation ?? []).flatMap((turn) =>
      JSON.stringify(turn).includes("a".repeat(4000)) ? [turn] : [],
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

/** A transcript of `rounds` tool rounds, with a text-only feedback message after each. */
function transcript(rounds: number): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  for (let round = 1; round <= rounds; round += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", text: `why ${round}`, signature: `sig-${round}` },
        { type: "tool_use", id: `call-${round}`, name: "shell", input: {} },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", toolUseId: `call-${round}`, content: `result ${round}` }],
    });
    messages.push({ role: "user", content: [{ type: "text", text: `nudge ${round}` }] });
  }
  return messages;
}

describe("pruneToolResultsForRequest (B-564 unit cases)", () => {
  it("test_option_absent_returns_the_same_array", () => {
    const messages = transcript(3);

    expect(pruneToolResultsForRequest(messages, undefined)).toBe(messages);
  });

  it("test_the_input_is_not_mutated", () => {
    const messages = transcript(3);
    const before = structuredClone(messages);

    pruneToolResultsForRequest(messages, { olderThanRounds: 1 });

    expect(messages).toEqual(before);
  });

  it("test_pruning_the_same_messages_twice_is_byte_identical_for_a_resumed_session", () => {
    const messages = transcript(4);

    const first = JSON.stringify(pruneToolResultsForRequest(messages, { olderThanRounds: 2 }));
    const second = JSON.stringify(
      pruneToolResultsForRequest(structuredClone(messages), { olderThanRounds: 2 }),
    );

    expect(second).toBe(first);
  });

  it("test_text_only_feedback_messages_do_not_count_as_rounds_and_stay_unchanged", () => {
    const messages = transcript(3);

    const pruned = pruneToolResultsForRequest(messages, { olderThanRounds: 2 });

    expect(toolResultsOf(pruned[2])[0]?.content).toBe("[tool result pruned: older than 2 rounds]");
    expect(toolResultsOf(pruned[5])[0]?.content).toBe("result 2");
    expect(toolResultsOf(pruned[8])[0]?.content).toBe("result 3");
    for (const index of [0, 1, 3, 4, 6, 7, 9]) {
      expect(pruned[index]).toBe(messages[index]);
    }
  });

  it("test_EC1_olderThanRounds_equal_to_or_beyond_history_prunes_nothing", () => {
    const messages = transcript(3);

    expect(pruneToolResultsForRequest(messages, { olderThanRounds: 3 })).toEqual(messages);
    expect(pruneToolResultsForRequest(messages, { olderThanRounds: 10 })).toEqual(messages);
  });

  it("test_EC2_an_aged_error_result_keeps_isError_and_its_toolUseId", () => {
    const messages: LlmMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "old", content: "boom", isError: true }],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "new", content: "fine" }] },
    ];

    const pruned = pruneToolResultsForRequest(messages, { olderThanRounds: 1 });

    expect(toolResultsOf(pruned[0])).toEqual([
      {
        type: "tool_result",
        toolUseId: "old",
        content: "[tool result pruned: older than 1 rounds]",
        isError: true,
      },
    ]);
  });

  it("test_EC4_two_tool_results_in_one_message_are_one_round_and_are_stubbed_together", () => {
    const messages: LlmMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "block" }] },
          { type: "text", text: "kept" },
          { type: "tool_result", toolUseId: "b", content: "plain" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "c", content: "newest" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "d", content: "newer" }] },
    ];

    const pruned = pruneToolResultsForRequest(messages, { olderThanRounds: 2 });

    expect(pruned[0]?.content).toEqual([
      { type: "tool_result", toolUseId: "a", content: "[tool result pruned: older than 2 rounds]" },
      { type: "text", text: "kept" },
      { type: "tool_result", toolUseId: "b", content: "[tool result pruned: older than 2 rounds]" },
    ]);
    expect(pruned[1]).toBe(messages[1]);
    expect(pruned[2]).toBe(messages[2]);
  });
});

describe("validatePruneToolResults (B-564 invalid cases)", () => {
  it.each([
    0,
    1.5,
    Number.NaN,
    -1,
  ])("test_olderThanRounds_%s_is_a_ConfigurationError_naming_it", (value) => {
    const attempt = () => validatePruneToolResults({ olderThanRounds: value });

    expect(attempt).toThrow(ConfigurationError);
    expect(attempt).toThrow(String(value));
    expect(attempt).toThrow(expect.objectContaining({ code: "invalid_prune_tool_results" }));
  });

  it("test_EC3_an_option_without_olderThanRounds_or_with_a_string_is_a_typed_error", () => {
    for (const option of [{}, { olderThanRounds: "3" }]) {
      expect(() => validatePruneToolResults(option as never)).toThrow(ConfigurationError);
    }
  });

  it("test_an_absent_option_and_a_valid_one_pass", () => {
    expect(() => validatePruneToolResults(undefined)).not.toThrow();
    expect(() => validatePruneToolResults({ olderThanRounds: 1 })).not.toThrow();
  });
});

describe("SendOptions.pruneToolResults at the send boundary (B-564)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    0,
    1.5,
    Number.NaN,
  ])("test_invalid_olderThanRounds_%s_fails_typed_before_any_provider_call", async (value) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no provider call is expected"));
    // Typed on SendOptions once T1.2 declares the field; until then the run ignores it.
    const sendOptions = { pruneToolResults: { olderThanRounds: value } };

    const run = createRealLocalRun({
      agentId: "prune-boundary",
      model: { id: "claude-sonnet-4-6" },
      message: "hello",
      agentOptions: { apiKey: "sk-ant-test-key" },
      sendOptions,
      workspaceCwd: process.cwd(),
      hooks: {} as never,
    } as never);
    const result = await run.wait();

    expect(fetchSpy).not.toHaveBeenCalled();
    const cause = (result.error as { cause?: unknown } | undefined)?.cause;
    expect(cause).toBeInstanceOf(ConfigurationError);
    expect((cause as ConfigurationError).code).toBe("invalid_prune_tool_results");
    expect((cause as ConfigurationError).message).toContain(String(value));
  });
});
