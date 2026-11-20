---
"@theokit/sdk": minor
---

`AgentFactory.create({ defaults, pinned })`: pinned options cannot be changed by per-session overrides. `local`, `memory`, `cloud` and `sendDefaults` merge key by key with pinned keys winning, and `withheldBuiltinTools` is a union. A config mixing `defaults`/`pinned` with other `AgentOptions` keys throws `ConfigurationError` (#1021).
