---
"@theokit/sdk": major
---

`AgentOptions.sendDefaults` now accepts `doomLoop`, merged key by key like the other defaults; a `doomLoop` passed to `send` wins.

Breaking for type consumers: the `sendDefaults` property type widens, which the API surface check reports as a change to the optional property.
