---
"@theokit/acp": minor
---

Add `@theokit/acp/client`: `connectAcpAgent` spawns another ACP agent over stdio on the ACP SDK's `ClientSideConnection`, streams its session updates, answers its permission requests through `onPermission`, sends `session/cancel` on abort, and kills the child's process group on `close()`. The child gets exactly the `env` you pass, and a bare `command` is resolved on absolute `PATH` entries only. Failures to start or an early exit throw `AcpAgentSpawnError`.
