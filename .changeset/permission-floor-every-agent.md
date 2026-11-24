---
"@theokit/sdk": major
---

The permission floor (protected paths, critical paths, destructive commands) now applies to every agent, with or without `PermissionPlugin`, in every permission mode. The agent loop checks it before plugins and file hooks, against the agent's workspace cwd, and a refusal is an exit-code-126 tool result plus a `permission_denied` event with `source: "floor"`. `RunPermissionDeniedEvent.source` gains `"floor"` (a widened union, so exhaustive switches must handle it). `PreToolCallContext` gains an optional `cwd`. Hypothesis to check: an app whose own tool (name matching `write*`, `edit*`, `apply_patch`, `multi_edit`, `notebook_edit` or `create*`) writes under `.theokit/` or `.claude/` will now be refused.
