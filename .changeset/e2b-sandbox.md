---
'@theokit/sdk': minor
---

`E2BSandbox` in `@theokit/sdk/sandbox`: a `SandboxBackend` over an E2B sandbox you created. It maps `CommandExitError` to the real exit code and `TimeoutError` to 124, throws `SandboxNotAvailableError` for a stopped or unreachable sandbox instead of reporting a timeout, applies `envs` and `NODE_EXTRA_CA_CERTS` to every command, and exposes the `networkPolicy` it was given. It takes the `e2b` `Sandbox` instance, so `e2b` is not a dependency.
