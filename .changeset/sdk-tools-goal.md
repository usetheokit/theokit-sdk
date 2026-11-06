---
'@theokit/sdk-tools': minor
---

`createGoalTool`, from the `@theokit/sdk-tools/goal` subpath, adds a `goal` tool that keeps one
standing goal per session across turns, for an objective that outlives a single turn (a checklist
stays with `todolist`). Its actions are `set`, `get`, `complete` and `clear`. `set` replaces an
existing goal and returns the previous text; `complete` on a finished goal is refused. Goals are
keyed by the run's `ctx.threadId`, so one tool object serves many sessions, and calls without a
thread id share one default goal. The goal lives in memory only and does not survive a restart.
Goal text is trimmed and capped at 2000 characters by default (`maxGoalChars`); every failure is a
typed result (`missing_goal`, `goal_too_long`, `no_goal`, `already_done`, `invalid_action`), never
a throw. It ships from its own subpath rather than the package root, so the root bundle stays
within its gzip budget.
