import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ScoreContext, ScoredToolCall } from "../../src/eval.js";
import { Eval, Scorers } from "../../src/eval.js";
import type { SDKAgent } from "../../src/types/agent.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

const CWD = mkdtempSync(join(tmpdir(), "theokit-eval-toolcalls-"));
afterAll(() => removeTempDirRobustSync(CWD));

function ctx(names: Array<string | [string, Record<string, unknown>]>): ScoreContext {
  return {
    input: "x",
    toolCalls: names.map((n) => {
      const [name, input] = typeof n === "string" ? [n, {}] : n;
      return { name, input, isError: false } as ScoredToolCall;
    }),
  };
}

function agentWithCalls(): SDKAgent {
  return {
    agentId: "a",
    send: () =>
      Promise.resolve({
        id: "r1",
        events: async function* () {
          const base = {
            type: "tool_call",
            agent_id: "a",
            run_id: "r1",
            call_id: "c1",
            name: "search",
          };
          yield { kind: "message", message: { ...base, status: "running", args: { q: "cats" } } };
          yield { kind: "message", message: { ...base, status: "completed", result: "found" } };
        },
        wait: () => Promise.resolve({ status: "finished" as const, result: "done" }),
      }),
  } as unknown as SDKAgent;
}

describe("scorer context", () => {
  it("scorer_receives_tool_calls (instance path)", async () => {
    let seen: ScoreContext | undefined;
    await Eval.create({
      name: "ctx-instance",
      dataset: [{ input: "hi", metadata: { k: 1 } }],
      scorers: [
        {
          name: "spy",
          score: (_o, _e, c) => {
            seen = c;
            return { score: 1 };
          },
        },
      ],
      agent: agentWithCalls(),
    }).run();
    expect(seen?.input).toBe("hi");
    expect(seen?.metadata).toEqual({ k: 1 });
    expect(seen?.toolCalls).toEqual([
      { name: "search", input: { q: "cats" }, output: "found", isError: false },
    ]);
  });

  it("scorer_receives_tool_calls (AgentOptions path, real fixture run)", async () => {
    let seen: ScoreContext | undefined;
    const run = await Eval.create({
      name: "ctx-options",
      dataset: [{ input: "Run two shell commands" }],
      scorers: [
        {
          name: "spy",
          score: (_o, _e, c) => {
            seen = c;
            return { score: 1 };
          },
        },
      ],
      agent: {
        apiKey: "theo_test_eval",
        model: { id: "openai/gpt-4o-mini" },
        local: { cwd: CWD, sandboxOptions: { enabled: false } as const },
      },
      concurrency: 1,
    }).run();
    expect(run.aggregate.errorRows).toBe(0);
    expect(seen?.toolCalls.length).toBe(2);
    expect(typeof seen?.toolCalls[0]?.name).toBe("string");
  });
});

describe("Scorers.toolCallAccuracy", () => {
  it("tool_call_accuracy_scores_partial_match", () => {
    const s = Scorers.toolCallAccuracy();
    const r = s.score(
      "",
      { toolCalls: [{ name: "search", input: { q: "cats" } }, { name: "read" }] },
      ctx([["search", { q: "cats", extra: 1 }]]),
    );
    expect((r as { score: number }).score).toBe(0.5);
  });

  it("tool_call_accuracy_rejects_extra_call", () => {
    const s = Scorers.toolCallAccuracy({ allowExtra: false });
    const r = s.score("", { toolCalls: [{ name: "search" }] }, ctx(["search", "delete"]));
    expect(r).toEqual({ score: 0, reason: "unexpected_tool_call:delete" });
  });

  it("exact input matching ignores key order but not distinct keys", () => {
    const sc = Scorers.toolCallAccuracy({ matchInput: "exact" });
    const want = { toolCalls: [{ name: "a", input: { b: 1, a: { y: 2, x: 1 }, B: 3 } }] };
    const score = (input: Record<string, unknown>) =>
      (sc.score("", want, ctx([["a", input]])) as { score: number }).score;
    expect(score({ B: 3, a: { x: 1, y: 2 }, b: 1 })).toBe(1);
    expect(score({ b: 1, a: { y: 2, x: 1 }, C: 3 })).toBe(0);
  });

  it("matchInput exact vs ignore and metadata fallback", () => {
    const want = { toolCalls: [{ name: "a", input: { x: 1 } }] };
    const calls = ctx([["a", { x: 1, y: 2 }]]);
    expect(
      (
        Scorers.toolCallAccuracy({ matchInput: "exact" }).score("", want, calls) as {
          score: number;
        }
      ).score,
    ).toBe(0);
    expect(
      (
        Scorers.toolCallAccuracy({ matchInput: "ignore" }).score("", want, calls) as {
          score: number;
        }
      ).score,
    ).toBe(1);
    const viaMeta = { ...calls, metadata: { expectedToolCalls: [{ name: "a" }] } };
    expect(
      (Scorers.toolCallAccuracy().score("", undefined, viaMeta) as { score: number }).score,
    ).toBe(1);
  });
});

describe("Scorers.trajectory", () => {
  it("trajectory_strict_and_subsequence", () => {
    const calls = ctx(["search", "plan", "read"]);
    const want = { trajectory: ["search", "read"] };
    expect(Scorers.trajectory().score("", want, calls)).toEqual({ score: 1 });
    const strict = Scorers.trajectory({ order: "strict" }).score("", want, calls) as {
      score: number;
      reason: string;
    };
    expect(strict.score).toBe(0);
    expect(strict.reason).toContain("position:2");
    expect(
      Scorers.trajectory({ order: "any" }).score("", { trajectory: ["read", "search"] }, calls),
    ).toEqual({ score: 1 });
  });
});

describe("malformed expected", () => {
  it("missing_expected_scores_zero_with_reason", () => {
    expect(Scorers.toolCallAccuracy().score("", undefined, ctx([]))).toEqual({
      score: 0,
      reason: "expected_tool_calls_missing",
    });
    expect(Scorers.toolCallAccuracy().score("", { toolCalls: [{ nope: 1 }] }, ctx([]))).toEqual({
      score: 0,
      reason: "expected_tool_calls_missing",
    });
    expect(Scorers.trajectory().score("", { trajectory: [1] }, ctx([]))).toEqual({
      score: 0,
      reason: "expected_trajectory_missing",
    });
    expect(Scorers.trajectory().score("", "x")).toEqual({
      score: 0,
      reason: "expected_trajectory_missing",
    });
  });
});
