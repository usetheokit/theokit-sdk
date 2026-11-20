---
"@theokit/sdk": minor
---

Export `runPreToolCall`, `guardTools`, `GuardToolsContext` and `ToolCallBlockedError` so tool calls dispatched outside the agent loop (code-mode scripts, MCP endpoints, relays) pass the agent's `pre_tool_call` plugins.
