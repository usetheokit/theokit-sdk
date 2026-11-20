---
"@theokit/sdk": minor
---

`LinuxSandbox` and `createSandboxBackend` accept `network: { allow }`: a host allowlist enforced through a host-side egress proxy while the confined process keeps an empty network namespace. `startEgressProxy`, `EgressRule` and `EgressProxy` are exported from `@theokit/sdk/sandbox`. Without bubblewrap the option throws `SandboxNotAvailableError` instead of falling back.
