---
"@theokit/sdk": minor
---

Export `mergeAgentOptions`, which merges AgentOptions layers (later wins; `local`/`memory`/`cloud` merge by key; `plugins` and `tools` combine). `PluginsSettings` gains `code` for code plugins next to named ones. `AgentFactory` still replaces collections.
