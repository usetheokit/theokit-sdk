---
'@theokit/sdk': patch
---

Security: a command confined by `LinuxSandbox` or `interactiveWrapCommand` can no longer weaken the
seccomp filter that later confined commands load. The filter used to be read from a temp file under
`/tmp`, which `workspace-write` commands can write, so one command could replace it with an
allow-all program. Both wraps now pipe the program to bubblewrap from memory, and no file holds it.

`wrapCommandForSandbox` takes a new optional `seccompProgram` (the program's bytes, a positive
multiple of 8; a `TypeError` otherwise). It wins over `seccompPath` when both are given.

`seccompPath`, `restrictedSeccompPath` and `seccompPathForArch` are deprecated in favour of
`seccompProgram`, and keep working. With `seccompPath` the wrap now binds the filter's directory
read-only, or the file where the directory is a writable root or contains one. That is only a
partial fix: a temp dir nested inside a writable root can still be swapped by renaming an ancestor,
and where only the file is bound its parent can be renamed.
