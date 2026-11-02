import { beforeEach, describe, expect, it } from "vitest";
import { createGoalTool } from "../src/goal.js";

type Envelope = Record<string, unknown> & { ok: boolean };

function call(
  tool: ReturnType<typeof createGoalTool>,
  input: unknown,
  threadId?: string,
): Envelope {
  const ctx = threadId === undefined ? undefined : { threadId };
  return JSON.parse(tool.handler(input as never, ctx)) as Envelope;
}

describe("createGoalTool", () => {
  let tool: ReturnType<typeof createGoalTool>;

  beforeEach(() => {
    tool = createGoalTool();
  });

  it("sets_a_goal_ends_the_turn_and_reads_it_back_in_the_next", () => {
    const set = call(tool, { action: "set", goal: "  Ship the release notes  " }, "sess-1");
    expect(set.ok).toBe(true);
    expect(set.replaced).toBe(false);
    expect(set).not.toHaveProperty("previous");
    expect(set.goal).toMatchObject({ text: "Ship the release notes", status: "active" });

    // A later turn of the same session: a fresh call with only the thread id.
    const got = call(tool, { action: "get" }, "sess-1");
    expect(got.ok).toBe(true);
    expect(got.goal).toMatchObject({ text: "Ship the release notes", status: "active" });
    expect(typeof (got.goal as { setAt: unknown }).setAt).toBe("number");
    expect(tool.getGoal("sess-1")?.text).toBe("Ship the release notes");
  });

  it("gets_null_when_no_goal_is_set", () => {
    const got = call(tool, { action: "get" }, "sess-1");
    expect(got).toEqual({ ok: true, goal: null });
    expect(tool.getGoal("sess-1")).toBeNull();
  });

  it("replaces_a_goal_and_reports_the_previous_text", () => {
    call(tool, { action: "set", goal: "First goal" }, "sess-1");
    call(tool, { action: "complete" }, "sess-1");
    const second = call(tool, { action: "set", goal: "Second goal" }, "sess-1");
    expect(second.ok).toBe(true);
    expect(second.replaced).toBe(true);
    expect(second.previous).toBe("First goal");
    expect(second.goal).toMatchObject({ text: "Second goal", status: "active" });
    expect(second.goal).not.toHaveProperty("completedAt");
  });

  it("completes_a_goal_and_refuses_a_second_completion", () => {
    call(tool, { action: "set", goal: "Finish the migration" }, "sess-1");
    const done = call(tool, { action: "complete" }, "sess-1");
    expect(done.ok).toBe(true);
    expect(done.goal).toMatchObject({ text: "Finish the migration", status: "done" });
    const completedAt = (done.goal as { completedAt: unknown }).completedAt;
    expect(typeof completedAt).toBe("number");

    const again = call(tool, { action: "complete" }, "sess-1");
    expect(again).toEqual({ ok: false, error: "already_done" });
    expect(tool.getGoal("sess-1")?.completedAt).toBe(completedAt);
  });

  it("refuses_to_complete_when_no_goal_is_set", () => {
    expect(call(tool, { action: "complete" }, "sess-1")).toEqual({ ok: false, error: "no_goal" });
  });

  it("clears_a_goal", () => {
    call(tool, { action: "set", goal: "Temporary" }, "sess-1");
    expect(call(tool, { action: "clear" }, "sess-1")).toEqual({ ok: true, goal: null });
    expect(call(tool, { action: "get" }, "sess-1")).toEqual({ ok: true, goal: null });
    // A finished goal clears too, and clearing with no goal is still a success.
    call(tool, { action: "set", goal: "Finished" }, "sess-1");
    call(tool, { action: "complete" }, "sess-1");
    expect(call(tool, { action: "clear" }, "sess-1")).toEqual({ ok: true, goal: null });
    expect(call(tool, { action: "clear" }, "sess-1")).toEqual({ ok: true, goal: null });
  });

  it("isolates_goals_per_thread_id", () => {
    call(tool, { action: "set", goal: "Goal of A" }, "sess-A");
    expect(call(tool, { action: "get" }, "sess-B")).toEqual({ ok: true, goal: null });
    expect(call(tool, { action: "complete" }, "sess-B")).toEqual({ ok: false, error: "no_goal" });
    expect(tool.getGoal("sess-A")?.text).toBe("Goal of A");
    expect(tool.getGoal()).toBeNull();
  });

  it("shares_one_default_goal_without_a_thread_id", () => {
    call(tool, { action: "set", goal: "Shared goal" });
    const got = call(tool, { action: "get" });
    expect(got.goal).toMatchObject({ text: "Shared goal", status: "active" });
    expect(tool.getGoal()?.text).toBe("Shared goal");
    expect(call(tool, { action: "get" }, "sess-1")).toEqual({ ok: true, goal: null });
  });

  it("returns_typed_errors_for_bad_input", () => {
    const small = createGoalTool({ maxGoalChars: 10 });
    const cases: Array<[unknown, string]> = [
      [{ action: "set" }, "missing_goal"],
      [{ action: "set", goal: "" }, "missing_goal"],
      [{ action: "set", goal: "   " }, "missing_goal"],
      [{ action: "set", goal: 42 }, "missing_goal"],
      [{ action: "set", goal: { text: "x" } }, "missing_goal"],
      [{ action: "set", goal: "a".repeat(11) }, "goal_too_long"],
      [{ action: "rename" }, "invalid_action"],
      [{}, "invalid_action"],
      [null, "invalid_action"],
    ];
    for (const [input, error] of cases) {
      let result: Envelope | undefined;
      expect(() => {
        result = call(small, input, "sess-1");
      }).not.toThrow();
      expect(result).toEqual({ ok: false, error });
    }
    expect(call(small, { action: "set", goal: "a".repeat(10) }, "sess-1").ok).toBe(true);
    // The bound applies after trimming, and the default bound is 2000 characters.
    expect(call(small, { action: "set", goal: `  ${"b".repeat(10)}  ` }, "sess-1").ok).toBe(true);
    expect(call(tool, { action: "set", goal: "c".repeat(2000) }, "sess-1").ok).toBe(true);
    expect(call(tool, { action: "set", goal: "c".repeat(2001) }, "sess-1")).toEqual({
      ok: false,
      error: "goal_too_long",
    });
    expect(() => createGoalTool({ maxGoalChars: 0 })).toThrow(/maxGoalChars.*0/);
    expect(() => createGoalTool({ maxGoalChars: 1.5 })).toThrow(/maxGoalChars.*1\.5/);
  });

  it("describes_when_to_use_and_lists_the_four_actions", () => {
    expect(tool.name).toBe("goal");
    const d = tool.description;
    for (const action of ["'set'", "'get'", "'complete'", "'clear'"]) expect(d).toContain(action);
    expect(d.toLowerCase()).toContain("use it");
    expect(d).toContain("todolist");
    expect(d).toContain("2000 characters");
    expect(createGoalTool({ maxGoalChars: 10 }).description).toContain("10 characters");
    for (const code of [
      "missing_goal",
      "goal_too_long",
      "no_goal",
      "already_done",
      "invalid_action",
    ])
      expect(d).toContain(code);
    const schema = tool.inputSchema as {
      properties: { action: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.action.enum).toEqual(["set", "get", "complete", "clear"]);
    expect(schema.required).toEqual(["action"]);
  });
});
