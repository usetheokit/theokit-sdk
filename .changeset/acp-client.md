---
"@theokit/acp": minor
---

Add `@theokit/acp/client`: `connectAcpAgent` spawns an ACP agent and drives it through the ACP SDK's `ClientSideConnection` (streamed prompt updates, permission callback, `session/cancel` on abort, process-group cleanup). Commands resolve on absolute `PATH` entries only and `process.env` is never inherited. Also exports `AcpAgentSpawnError`.
