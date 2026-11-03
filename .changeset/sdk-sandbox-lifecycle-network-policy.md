---
'@theokit/sdk': minor
---

A custom `SandboxBackend` can now release what it holds with `dispose()` (a no-op by default, safe to call twice) and state its egress with an optional `networkPolicy` of type `SandboxNetworkPolicy`; `LocalSandbox` declares `unrestricted` and `LinuxSandbox` declares `none` when the network is unshared (`usetheokit/theokit#1130`). `@theokit/sdk/sandbox` also exports `shellEscapePosix`, so a command line built outside a backend subclass can quote its arguments (`usetheokit/theokit#1131`).
