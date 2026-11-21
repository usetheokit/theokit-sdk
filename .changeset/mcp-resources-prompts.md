---
"@theokit/sdk": minor
---

Add `@theokit/sdk/mcp` with `connectMcpServer`, which lists and reads a server's resources and lists and renders its prompts. A server without the capability rejects with `mcp_capability_missing`; a JSON-RPC error becomes a `NetworkError` of code `mcp_rpc_error`.
