---
"@theokit/sdk": major
---

The builtin `shell` tool is now opt-in. A local agent no longer declares `shell` unless `AgentOptions.builtinTools` includes `"shell"`. `withheldBuiltinTools: ["shell"]` still removes it and wins over the opt-in; delegated subagents inherit the parent's opt-in. `effectiveToolNames` reports `shell` only when opted in.

Migration: if your agent runs shell commands, add `builtinTools: ["shell"]` (and, for a permission policy, install a permission plugin that allows `shell`). The shell is still unsandboxed unless `local.sandboxOptions.enabled` is true.
