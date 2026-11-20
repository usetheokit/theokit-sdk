---
"@theokit/sdk": major
---

sandbox: add the optional `SandboxBackend.executeStreaming`, which reports each stdout line while the command runs and stops it when an `AbortSignal` aborts. `LocalSandbox` and `LinuxSandbox` implement it; other backends leave it absent, so callers fall back to `execute`.
