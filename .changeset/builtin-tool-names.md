---
"@theokit/sdk": minor
---

New runtime exports `BUILTIN_TOOL_NAMES` and `isBuiltinToolName`, so an app that accepts tool names from configuration can refuse one that collides with an SDK builtin at load time.
