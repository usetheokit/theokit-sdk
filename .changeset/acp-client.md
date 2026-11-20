---
"@theokit/acp": minor
---

Add `@theokit/acp/client`: `connectAcpAgent` spawns another ACP agent over stdio with the ACP SDK's `ClientSideConnection`, streams its `session/update` notifications from `prompt()`, answers permission requests through `onPermission`, and sends `session/cancel` when the signal aborts. The child gets only the `env` you pass, and a bare command is resolved on absolute `PATH` entries only. Failures to start or a child exiting mid-prompt reject with `AcpAgentSpawnError` (exit code and last stderr lines).
