/**
 * `todolist` — in-session task tracking for multi-step work.
 *
 * The agent uses this to plan complex tasks and track progress.
 * Inspired by a peer project's todo.ts and Claude Code's TodoWrite.
 *
 * Actions:
 *   - add(title)         → add a new todo item
 *   - complete(id)       → mark an item done
 *   - remove(id)         → remove an item
 *   - list()             → show all items with status
 *   - clear_completed()  → remove all done items
 *
 * #119 — state is keyed by `ctx.threadId` (the run's session identity, injected by the
 * SDK from `Agent.getOrCreate(sessionId, …)`). One tool object served to many sessions
 * from a single process keeps each session's list isolated. When no `threadId` is present
 * (single-session CLI usage) every call shares one default session — behavior unchanged.
 */

import type { CustomTool } from "@theokit/sdk";

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done";
  createdAt: number;
  completedAt?: number;
}

/**
 * The `todolist` tool object. It is hand-built rather than produced by `Tool.create`, so
 * `inputSchema` is a plain JSON Schema value and `handler` is synchronous.
 *
 * `getItems` is a test seam onto the same session state the handler mutates, reachable without going
 * through an action.
 */
export interface TodolistTool extends CustomTool {
  /** Synchronous: narrows `CustomTool`'s return type, so callers can parse the result without awaiting. */
  handler: (input: Record<string, unknown>, ctx?: { threadId?: string }) => string;
  /** Expose a session's items for testing (defaults to the no-threadId session). */
  getItems(threadId?: string): TodoItem[];
}

type TodoInput =
  | { action: "add"; title: string }
  | { action: "complete"; id: string }
  | { action: "in_progress"; id: string }
  | { action: "remove"; id: string }
  | { action: "list" }
  | { action: "clear_completed" };

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data });
}

function fail(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, ...data });
}

function requireId(input: TodoInput): string | null {
  if (!("id" in input) || !input.id) return null;
  return input.id;
}

/** The stateful machinery for ONE session — its own `items` array and id counter. */
function makeSessionOps(): { handle: (input: TodoInput) => string; getItems: () => TodoItem[] } {
  const items: TodoItem[] = [];
  let nextId = 1;

  function genId(): string {
    return `todo-${nextId++}`;
  }

  function findById(id: string): TodoItem | undefined {
    return items.find((i) => i.id === id);
  }

  // M4-5: every list-bearing success result carries BOTH the human `items_summary`
  // (for the LLM) AND the structured `items` snapshot (for programmatic consumers
  // that render a plan/UI).
  function listResult(extra: Record<string, unknown>): string {
    return ok({ ...extra, items: [...items], items_summary: formatList() });
  }

  function formatList(): string {
    if (items.length === 0) return "No tasks. Use action 'add' to create one.";
    const lines = items.map((item) => {
      const icon = item.status === "done" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
      return `${icon} ${item.id}: ${item.title}`;
    });
    const pending = items.filter((i) => i.status === "pending").length;
    const inProg = items.filter((i) => i.status === "in_progress").length;
    const done = items.filter((i) => i.status === "done").length;
    lines.push(`\n${done}/${items.length} done | ${inProg} in progress | ${pending} pending`);
    return lines.join("\n");
  }

  function handleAdd(input: TodoInput): string {
    if (!("title" in input) || !input.title) return fail({ error: "missing_title" });
    const item: TodoItem = {
      id: genId(),
      title: input.title,
      status: "pending",
      createdAt: Date.now(),
    };
    items.push(item);
    return listResult({ id: item.id, message: `Added: ${item.title}` });
  }

  function handleSetStatus(input: TodoInput, status: "in_progress" | "done"): string {
    const id = requireId(input);
    if (!id) return fail({ error: "missing_id" });
    const item = findById(id);
    if (!item) return fail({ error: "not_found", id });
    item.status = status;
    if (status === "done") item.completedAt = Date.now();
    const verb = status === "done" ? "Completed" : "Started";
    return listResult({ message: `${verb}: ${item.title}` });
  }

  function handleRemove(input: TodoInput): string {
    const id = requireId(input);
    if (!id) return fail({ error: "missing_id" });
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return fail({ error: "not_found", id });
    const removed = items.splice(idx, 1)[0]!;
    return listResult({ message: `Removed: ${removed.title}` });
  }

  function handleClearCompleted(): string {
    const before = items.length;
    const kept = items.filter((i) => i.status !== "done");
    items.length = 0;
    items.push(...kept);
    return listResult({ message: `Cleared ${before - items.length} completed items` });
  }

  const actions: Record<string, (input: TodoInput) => string> = {
    add: handleAdd,
    in_progress: (input) => handleSetStatus(input, "in_progress"),
    complete: (input) => handleSetStatus(input, "done"),
    remove: handleRemove,
    list: () => listResult({}),
    clear_completed: handleClearCompleted,
  };

  return {
    handle: (input: TodoInput): string => {
      const action = actions[input.action];
      if (!action) return fail({ error: "invalid_action" });
      return action(input);
    },
    getItems: () => [...items],
  };
}

/**
 * Build the `todolist` tool: an in-memory checklist the agent keeps across the turns of one session.
 *
 * State lives in the closure. It is never written anywhere and dies with the process, so this is a
 * working memo for the model, not a task store. One tool object can serve many sessions — lists are
 * keyed by `ctx.threadId`, and every call arriving without one shares a single default list, which
 * means a multi-session host that forgets to thread the id merges all its users' tasks together.
 *
 * Ids are `todo-1`, `todo-2`, … per session and are never reused, so a removed item's id stays gone.
 * Each successful action returns the whole list twice: `items` structured for a UI, `items_summary`
 * formatted for the model. Failures are `missing_title`, `missing_id`, `not_found` and
 * `invalid_action`.
 */
export function createTodolistTool(): TodolistTool {
  // #119 — one session-ops bundle per threadId; lazily created on first touch.
  const sessions = new Map<string, ReturnType<typeof makeSessionOps>>();
  function ops(threadId?: string): ReturnType<typeof makeSessionOps> {
    const key = threadId ?? "__default__";
    let session = sessions.get(key);
    if (session === undefined) {
      session = makeSessionOps();
      sessions.set(key, session);
    }
    return session;
  }

  return {
    name: "todolist",
    description:
      "Create and maintain a structured task list for the current session — tracks progress and " +
      "keeps a multi-step plan visible across turns. Use it proactively when the work has 3+ steps " +
      "or the user gave multiple tasks; skip it for a single trivial step. Keep exactly ONE item " +
      "'in_progress' at a time, and mark 'complete' only after the work is actually done. " +
      "Actions: 'add' (create with title), 'in_progress' (mark started by id), 'complete' (mark done " +
      "by id), 'remove' (delete by id), 'list' (show all), 'clear_completed' (remove done items). " +
      "Returns { ok, items, items_summary } (items = structured array; items_summary = formatted text).",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["add", "complete", "in_progress", "remove", "list", "clear_completed"],
          description: "The action to perform.",
        },
        title: {
          type: "string",
          description: "Title for a new todo item (required for 'add').",
        },
        id: {
          type: "string",
          description: "ID of the todo item (required for 'complete', 'in_progress', 'remove').",
        },
      },
      required: ["action"],
    },
    // The contract hands over `Record<string, unknown>`; the per-action handlers validate the
    // fields they read (`title`, `id`), and an unknown `action` is a typed `invalid_action` failure.
    handler: (input: Record<string, unknown>, ctx?: { threadId?: string }): string =>
      ops(ctx?.threadId).handle(input as TodoInput),
    getItems: (threadId?: string): TodoItem[] => ops(threadId).getItems(),
  };
}
