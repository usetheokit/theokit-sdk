---
"@theokit/sdk": minor
---

MCP server configs (`McpStdioServerConfig`, `McpHttpServerConfig`) accept `tools: { include?, exclude? }`. Filtered-out tools are not offered to the model, and a call to one is refused in the client before any request reaches the server. An `include` name the server does not list produces a diagnostics warning. Invalid lists throw `ConfigurationError` code `invalid_mcp_tool_filter` at `Agent.create`.
