---
"@theokit/sdk": major
---

Add the optional `SandboxBackend.executeStreaming` capability, implemented by `LocalSandbox` and `LinuxSandbox`: it reports stdout line by line while the command runs and stops the command when an `AbortSignal` aborts (#883).
