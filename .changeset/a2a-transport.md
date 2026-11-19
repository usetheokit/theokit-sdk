---
"@theokit/sdk": minor
---

A2A: `MessageBus` takes an optional `A2ATransport` so `send` reaches agents in other processes, with `pump()` to deliver waiting messages, `inMemoryTransport()`, and `A2ARemoteRequestUnsupportedError` for `request` to a remote-only peer (#1049).
