/**
 * `goal` — one standing goal per session, kept across turns.
 *
 * Actions:
 *   - set(goal)   → set the goal, replacing any existing one (reports `previous`)
 *   - get()       → read the current goal, or null
 *   - complete()  → mark the goal done
 *   - clear()     → drop the goal
 *
 * State is keyed by `ctx.threadId`, as in `todolist` (#119). Calls without a thread id share one
 * default session, so a multi-session host that forgets to thread the id merges its users' goals.
 * The goal lives in memory only and dies with the process.
 */

/** A session's goal: its text, whether it is still active, and when it was set and completed. */
export interface GoalState {
  text: string;
  status: "active" | "done";
  setAt: number;
  completedAt?: number;
}

/** Options for {@link createGoalTool}. */
export interface CreateGoalToolOptions {
  /** Longest goal text accepted, after trimming. A positive integer; defaults to 2000. */
  maxGoalChars?: number;
}

/**
 * The `goal` tool object. Hand-built like `todolist`: `inputSchema` is a plain JSON Schema value
 * and `handler` is synchronous. `getGoal` is a test seam onto the state the handler mutates.
 */
export interface GoalTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (input: GoalInput, ctx?: { threadId?: string }) => string;
  /** A session's goal (defaults to the no-threadId session), or null when none is set. */
  getGoal: (threadId?: string) => GoalState | null;
}

type GoalInput =
  | { action: "set"; goal: string }
  | { action: "get" }
  | { action: "complete" }
  | { action: "clear" };

const DEFAULT_MAX_GOAL_CHARS = 2000;
const DEFAULT_SESSION = "__default__";

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data });
}

function fail(error: string): string {
  return JSON.stringify({ ok: false, error });
}

function readMaxGoalChars(options: CreateGoalToolOptions | undefined): number {
  const max = options?.maxGoalChars ?? DEFAULT_MAX_GOAL_CHARS;
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError(`createGoalTool: maxGoalChars must be a positive integer, got ${max}`);
  }
  return max;
}

/**
 * Build the `goal` tool: the agent's one standing objective for a session, read back in later turns.
 *
 * Failures are typed, never thrown: `missing_goal`, `goal_too_long`, `no_goal`, `already_done` and
 * `invalid_action`. Only an invalid `maxGoalChars` throws, at construction.
 */
export function createGoalTool(options?: CreateGoalToolOptions): GoalTool {
  const maxGoalChars = readMaxGoalChars(options);
  const goals = new Map<string, GoalState>();

  function handleSet(key: string, input: Record<string, unknown>): string {
    const text = typeof input.goal === "string" ? input.goal.trim() : "";
    if (text === "") return fail("missing_goal");
    if (text.length > maxGoalChars) return fail("goal_too_long");
    const previous = goals.get(key);
    const goal: GoalState = { text, status: "active", setAt: Date.now() };
    goals.set(key, goal);
    if (previous === undefined) return ok({ goal, replaced: false });
    return ok({ goal, replaced: true, previous: previous.text });
  }

  function handleComplete(key: string): string {
    const goal = goals.get(key);
    if (goal === undefined) return fail("no_goal");
    if (goal.status === "done") return fail("already_done");
    goal.status = "done";
    goal.completedAt = Date.now();
    return ok({ goal });
  }

  function handle(input: unknown, key: string): string {
    const fields = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    switch (fields.action) {
      case "set":
        return handleSet(key, fields);
      case "get":
        return ok({ goal: goals.get(key) ?? null });
      case "complete":
        return handleComplete(key);
      case "clear":
        goals.delete(key);
        return ok({ goal: null });
      default:
        return fail("invalid_action");
    }
  }

  return {
    name: "goal",
    description:
      "Keep ONE standing goal for the current session, read back across turns. Use it when the user " +
      "states an objective that spans many turns, and check it with 'get' before deciding you are " +
      "finished; use todolist for the steps toward it. Actions: 'set' (store the goal text, at most " +
      `${maxGoalChars} characters after trimming, replacing any existing goal and returning it as ` +
      "previous), 'get' (current goal or null), 'complete' (mark it done), 'clear' (drop it). Returns " +
      "{ ok, goal } with goal = { text, status, setAt, completedAt }; failures are { ok: false, error } " +
      "with error one of missing_goal, goal_too_long, no_goal, already_done, invalid_action.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["set", "get", "complete", "clear"],
          description: "The action to perform.",
        },
        goal: {
          type: "string",
          description: "The goal text (required for 'set').",
        },
      },
      required: ["action"],
    },
    handler: (input: GoalInput, ctx?: { threadId?: string }): string =>
      handle(input, ctx?.threadId ?? DEFAULT_SESSION),
    getGoal: (threadId?: string): GoalState | null => {
      const goal = goals.get(threadId ?? DEFAULT_SESSION);
      return goal === undefined ? null : { ...goal };
    },
  };
}
