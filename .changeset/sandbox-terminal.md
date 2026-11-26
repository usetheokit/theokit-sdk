---
"@theokit/sdk": minor
---

`SandboxBackend` gains an optional `openTerminal(command, { cols, rows, cwd })` that runs a command under a pseudo-terminal and returns a `SandboxTerminal` (`write`, `resize`, `onData`, `wait`, `kill`). `E2BSandbox` offers it when the handle has `pty`, and `DockerSandbox` offers it through a TTY exec. Other backends are unchanged.
