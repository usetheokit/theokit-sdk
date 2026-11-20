import "../../src/agent.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getAgentFacade,
  setAgentFacade,
} from "../../src/internal/runtime/registry/agent-factory-registry.js";
import { Scorers } from "../../src/scorers.js";
import type { ScoreContext } from "../../src/types/eval.js";

const original = getAgentFacade();
afterEach(() => setAgentFacade(original));

function script(replies: string[]) {
  const prompt = vi.fn(async () => ({ status: "finished", result: replies.shift() ?? "" }));
  setAgentFacade({ ...original, prompt: prompt as never });
  return prompt;
}

const base = { model: { id: "judge" } as never, apiKey: "k" };
const ctx = (metadata?: Record<string, unknown>, toolCalls: ScoreContext["toolCalls"] = []) =>
  ({ input: "q", metadata, toolCalls }) as ScoreContext;

describe("judge scorers", () => {
  it("faithfulness_scores_supported_claims", async () => {
    const prompt = script([
      '{"claims":["A","B","C"]}',
      '{"verdicts":[{"index":0,"supported":true},{"index":1,"supported":false},{"index":2,"supported":true}]}',
    ]);
    const r = await Scorers.faithfulness(base).score("out", undefined, ctx({ context: "ctx" }));
    expect(r.score).toBeCloseTo(2 / 3);
    expect(r.reason).toContain("B");
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("faithfulness_without_context", async () => {
    const prompt = script([]);
    expect(await Scorers.faithfulness(base).score("out", undefined, ctx())).toEqual({
      score: 0,
      reason: "context_missing",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("faithfulness with no claims scores 1", async () => {
    script(['{"claims":[]}']);
    const r = await Scorers.faithfulness(base).score("out", undefined, ctx({ context: ["x"] }));
    expect(r).toEqual({ score: 1, reason: "no_claims" });
  });

  it("rubric_weights_items", async () => {
    script(['{"verdicts":[{"id":"a","pass":true},{"id":"b","pass":false}]}']);
    const s = Scorers.rubric({
      ...base,
      items: [
        { id: "a", description: "da", weight: 2 },
        { id: "b", description: "db" },
      ],
    });
    const r = await s.score("out");
    expect(r.score).toBeCloseTo(2 / 3);
    expect(r.reason).toContain("b");
  });

  it("rubric rejects duplicate ids", () => {
    expect(() =>
      Scorers.rubric({
        ...base,
        items: [
          { id: "a", description: "x" },
          { id: "a", description: "y" },
        ],
      }),
    ).toThrow();
  });

  it("judged_trajectory_sees_tool_calls", async () => {
    const prompt = script(['{"score":0.8,"reason":"fine"}']);
    const calls = [
      { name: "search", input: { q: 1 }, isError: false },
      { name: "read", input: {}, isError: true },
    ];
    const r = await Scorers.judgedTrajectory(base).score("out", undefined, ctx(undefined, calls));
    expect(r).toEqual({ score: 0.8, reason: "fine" });
    const sent = (prompt.mock.calls[0] as unknown as [string])[0];
    expect(sent.indexOf("search")).toBeGreaterThan(-1);
    expect(sent.indexOf("read")).toBeGreaterThan(sent.indexOf("search"));
  });

  it("unparseable_judge_reply", async () => {
    const want = { score: 0, reason: "judge_unparseable" };
    script(["nope"]);
    expect(await Scorers.faithfulness(base).score("o", undefined, ctx({ context: "c" }))).toEqual(
      want,
    );
    script(["nope"]);
    expect(
      await Scorers.rubric({ ...base, items: [{ id: "a", description: "d" }] }).score("o"),
    ).toEqual(want);
    script(["nope"]);
    expect(await Scorers.judgedTrajectory(base).score("o", undefined, ctx())).toEqual(want);
  });
});
