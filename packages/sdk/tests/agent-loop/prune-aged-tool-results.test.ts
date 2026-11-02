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
import type { SendOptions } from "../../src/types/run.js";
import type { SessionMessage } from "../../src/types/session-message.js";
import { driveLoop } from "../helpers/agent-loop-driver.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

const PRINT_4000_BYTES = "head -c 4000 /dev/zero | tr '\\0' a";

/** Two shell rounds that each print 4000 bytes, then a text close: the DISCOVER script. */
function twoShellRoundsThenText(
  recorded: string[],
  seen: LlmRequest[],
  live: LlmMessage[][] = [],
): LlmClient {
  let call = 0;
  return {
    name: "stub",
    async *stream(request: LlmRequest): AsyncGenerator<LlmEvent, LlmFinish, void> {
      call += 1;
      recorded.push(JSON.stringify(request.messages));
      seen.push({ ...request, messages: structuredClone(request.messages) });
      // Shallow copy: the elements are the loop's own message objects, so a later in-place edit of
      // the transcript shows through them (the clone above cannot show it).
      live.push([...request.messages]);
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
    const live: LlmMessage[][] = [];
    const { result } = await driveLoop(cwd, {
      llm: twoShellRoundsThenText(recorded, seen, live),
      userMessage: "go",
      ...(pruneToolResults !== undefined ? { pruneToolResults } : {}),
    });
    return { recorded, seen, live, result };
  }

  it("option off sends the measured 57 4282 and 8507 bytes", async () => {
    const { recorded } = await run();

    expect(recorded.slice(0, 3).map((json) => json.length)).toEqual([57, 4282, 8507]);
  });

  it("aged round 1 result is a stub at call 3 and round 2 stays whole", async () => {
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

  it("call 2 is unchanged because round 1 is not yet aged", async () => {
    const { recorded } = await run({ olderThanRounds: 1 });

    expect(recorded[1]?.length).toBe(4282);
  });

  it("round 3 request is at most 4800 bytes with olderThanRounds 1", async () => {
    const { recorded } = await run({ olderThanRounds: 1 });

    expect(recorded[2]?.length).toBeLessThanOrEqual(4800);
  });

  it("the transcript keeps every full result while requests are pruned", async () => {
    const { result } = await run({ olderThanRounds: 1 });
    const results = (result.conversation ?? []).flatMap((turn) =>
      JSON.stringify(turn).includes("a".repeat(4000)) ? [turn] : [],
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("the loop's own message objects keep both full results after the pruned request", async () => {
    const { live } = await run({ olderThanRounds: 1 });
    // Request 2 and 3 hold the loop transcript's own objects; round 1's result sits at index 2.
    const round1AtCall2 = toolResultsOf(live[1]?.[2]);
    const round1AtCall3 = toolResultsOf(live[2]?.[2]);
    const round2AtCall3 = toolResultsOf(live[2]?.[4]);

    expect(round1AtCall2[0]?.content).toBe("a".repeat(4000));
    expect(round1AtCall3[0]?.content).toContain("pruned");
    expect(round2AtCall3[0]?.content).toBe("a".repeat(4000));
    // The request-2 object for round 1 is the transcript's own: pruning request 3 must not edit it.
    expect(round1AtCall2[0]?.content, "pruning mutated the loop transcript").toBe("a".repeat(4000));
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
  it("option absent returns the same array", () => {
    const messages = transcript(3);

    expect(pruneToolResultsForRequest(messages, undefined)).toBe(messages);
  });

  it("the input is not mutated", () => {
    const messages = transcript(3);
    const before = structuredClone(messages);

    pruneToolResultsForRequest(messages, { olderThanRounds: 1 });

    expect(messages).toEqual(before);
  });

  it("pruning the same messages twice is byte identical for a resumed session", () => {
    const messages = transcript(4);

    const first = JSON.stringify(pruneToolResultsForRequest(messages, { olderThanRounds: 2 }));
    const second = JSON.stringify(
      pruneToolResultsForRequest(structuredClone(messages), { olderThanRounds: 2 }),
    );

    expect(second).toBe(first);
  });

  it("text only feedback messages do not count as rounds and stay unchanged", () => {
    const messages = transcript(3);

    const pruned = pruneToolResultsForRequest(messages, { olderThanRounds: 2 });

    expect(toolResultsOf(pruned[2])[0]?.content).toBe("[tool result pruned: older than 2 rounds]");
    expect(toolResultsOf(pruned[5])[0]?.content).toBe("result 2");
    expect(toolResultsOf(pruned[8])[0]?.content).toBe("result 3");
    for (const index of [0, 1, 3, 4, 6, 7, 9]) {
      expect(pruned[index]).toBe(messages[index]);
    }
  });

  it("EC-1 olderThanRounds equal to or beyond history prunes nothing", () => {
    const messages = transcript(3);

    expect(pruneToolResultsForRequest(messages, { olderThanRounds: 3 })).toEqual(messages);
    expect(pruneToolResultsForRequest(messages, { olderThanRounds: 10 })).toEqual(messages);
  });

  it("EC-2 an aged error result keeps isError and its toolUseId", () => {
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

  it("EC-4 two tool results in one message are one round and are stubbed together", () => {
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

describe("pruneToolResultsForRequest invariants (B-564)", () => {
  it("every tool_use keeps a tool_result with the same id after pruning", () => {
    const pruned = pruneToolResultsForRequest(transcript(4), { olderThanRounds: 1 });
    const useIds = pruned
      .flatMap((m) => m.content)
      .flatMap((p) => (p.type === "tool_use" ? [p.id] : []));
    const resultIds = pruned.flatMap(toolResultsOf).map((p) => p.toolUseId);

    expect(resultIds).toEqual(useIds);
  });

  it("a result shorter than the stub is still replaced, so that request part may grow", () => {
    const pruned = pruneToolResultsForRequest(transcript(2), { olderThanRounds: 1 });
    const aged = toolResultsOf(pruned[2])[0]?.content as string;

    expect(aged).toBe("[tool result pruned: older than 1 rounds]");
    expect(aged.length).toBeGreaterThan("result 1".length);
  });
});

describe("validatePruneToolResults (B-564 invalid cases)", () => {
  it.each([
    0,
    1.5,
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("olderThanRounds %s is a ConfigurationError naming it", (value) => {
    const attempt = () => validatePruneToolResults({ olderThanRounds: value });

    expect(attempt).toThrow(ConfigurationError);
    expect(attempt).toThrow(String(value));
    expect(attempt).toThrow(expect.objectContaining({ code: "invalid_prune_tool_results" }));
  });

  it("EC-3 an option without olderThanRounds or with a string is a typed error", () => {
    for (const option of [{}, { olderThanRounds: "3" }, { olderThanRounds: null }]) {
      expect(() => validatePruneToolResults(option as never)).toThrow(ConfigurationError);
    }
  });

  it("an absent option and a valid one pass", () => {
    expect(() => validatePruneToolResults(undefined)).not.toThrow();
    expect(() => validatePruneToolResults({ olderThanRounds: 1 })).not.toThrow();
  });
});

describe("pruneToolResults on a resumed session (B-564)", () => {
  /** A stored session of two tool rounds, as `replayMessages` rebuilds them from `parts`. */
  const storedSession: SessionMessage[] = [1, 2].flatMap((round): SessionMessage[] => [
    {
      role: "assistant",
      text: "",
      parts: [{ type: "tool_use", id: `prior-${round}`, name: "shell", input: { command: "x" } }],
    },
    {
      role: "user",
      text: "",
      parts: [{ type: "tool_result", toolUseId: `prior-${round}`, content: "a".repeat(4000) }],
    },
  ]);

  async function firstRequestOf(pruneToolResults?: { olderThanRounds: number }) {
    const cwd = await mkdtemp(join(tmpdir(), "theokit-prune-resume-"));
    onTestFinished(async () => {
      await removeTempDirRobust(cwd);
    });
    const { requests } = await driveLoop(cwd, {
      userMessage: "continue",
      priorMessages: storedSession,
      ...(pruneToolResults !== undefined ? { pruneToolResults } : {}),
    });
    return requests[0]?.messages ?? [];
  }

  it("the first request of a resumed run stubs the aged replayed result", async () => {
    const messages = await firstRequestOf({ olderThanRounds: 1 });
    const results = messages.flatMap(toolResultsOf);

    expect(results.map((part) => part.toolUseId)).toEqual(["prior-1", "prior-2"]);
    expect(results[0]?.content).toBe("[tool result pruned: older than 1 rounds]");
    expect(results[1]?.content).toBe("a".repeat(4000));
  });

  it("the same stored session without the option replays both results whole", async () => {
    const messages = await firstRequestOf();

    expect(messages.flatMap(toolResultsOf).map((part) => part.content)).toEqual([
      "a".repeat(4000),
      "a".repeat(4000),
    ]);
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
  ])("invalid olderThanRounds %s fails typed before any provider call", async (value) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no provider call is expected"));
    const sendOptions: SendOptions = { pruneToolResults: { olderThanRounds: value } };

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
