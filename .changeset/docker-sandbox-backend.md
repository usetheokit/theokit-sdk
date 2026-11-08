---
'@theokit/sdk': minor
---

`@theokit/sdk/sandbox` ships `DockerSandbox`, a `SandboxBackend` that runs each command in a
throwaway container with a read-only root filesystem, no network by default, dropped capabilities and
the workspace as the only writable mount, so a shell command cannot write outside its workspace.
