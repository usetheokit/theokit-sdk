---
"@theokit/sdk": patch
---

Agent loop: a forced call to an MCP tool outside the offered catalog is refused without reaching the server, `mcp_` names are never case-repaired onto another tool, and MCP name sanitization lives in one helper (#1208).
