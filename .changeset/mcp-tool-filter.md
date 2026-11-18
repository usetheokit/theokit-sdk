---
"@theokit/sdk": minor
---

Add `tools: { include, exclude }` to `McpStdioServerConfig` and `McpHttpServerConfig` to filter the tools an MCP server offers. A call to a filtered-out tool is refused before it reaches the server. A malformed filter is rejected at `Agent.create` with `invalid_mcp_tool_filter`.
