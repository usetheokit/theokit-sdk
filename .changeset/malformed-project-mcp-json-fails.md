---
"@theokit/sdk": patch
---

fix(sdk): a malformed `.theokit/mcp.json` (unreadable, invalid JSON, or `servers` not an object) now fails the send with a `ConfigurationError` naming the file, instead of silently running with no project MCP servers
