---
'@theokit/sdk': minor
---

Add `denyReadPaths` to the `@theokit/sdk/sandbox` backends (`LinuxSandbox`, `createSandboxBackend`, `interactiveWrapCommand`, `wrapCommandForSandbox` and `buildBwrapArgv`) so a `workspace-write` or `read-only` shell cannot read named absolute paths. A directory is masked with `--tmpfs` and reads as empty, a file with `--ro-bind /dev/null` and reads as permission denied; the mask is placed after the writable binds, so it also hides a path inside the workspace or `/tmp`. A masked file still appears in the listing of its directory. A list that cannot be honoured throws instead of running unconfined: `TypeError` for a relative or missing path, a path that contains the workspace, `/tmp` or `/`, or any list under `danger-full-access`, and `SandboxNotAvailableError` when bubblewrap is absent. Without the option nothing changes.
