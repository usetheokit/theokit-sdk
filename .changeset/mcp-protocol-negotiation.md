---
"@theokit/sdk": minor
---

The MCP client now negotiates the protocol version. `initialize` offers `2025-06-18` (or the revision pinned with the new `protocolVersion` server option), keeps the revision the server answers, and rejects an unsupported one with `NetworkError` code `mcp_protocol_unsupported`. HTTP requests send `MCP-Protocol-Version` after `initialize`, and `clientInfo.version` is the SDK's package version.
