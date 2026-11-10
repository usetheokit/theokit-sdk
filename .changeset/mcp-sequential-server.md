---
"@theokit/sdk": minor
---

`McpStdioServerConfig` and `McpHttpServerConfig` accept `sequential: true` (#932). The calls a model makes to that server's tools in one step then run one at a time, in the order the model listed them, and the results still come back in call order. Calls to other servers or to non-MCP tools in the same step are not held behind them. Without the option the calls still run at once. Use it for a stateful server such as Playwright MCP, where a snapshot must wait for the navigation before it.
