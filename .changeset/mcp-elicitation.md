---
"@theokit/sdk": minor
---

New `onMcpElicitation` agent option answers MCP elicitation requests from a server. The MCP client now routes server-to-client requests (stdio and the Streamable HTTP event stream) instead of mistaking them for replies, declares the `elicitation` capability only when a handler is set, and exports `McpElicitationHandler`, `McpElicitationRequest` and `McpElicitationResult`.
