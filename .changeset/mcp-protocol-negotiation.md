---
"@theokit/sdk": minor
---

The MCP client now negotiates the protocol version: `initialize` offers `2025-06-18` (or the server's new `protocolVersion` pin), accepts `2025-03-26` and `2024-11-05` answers, rejects others with `mcp_protocol_unsupported`, sends `MCP-Protocol-Version` on HTTP requests, and reports the SDK version in `clientInfo`.
