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
`seccompProgram`, and keep working. A `seccompPath` that `restrictedSeccompPath` or
`seccompPathForArch` returned is now piped from the bytes the process wrote, so a sandbox started
without the filter (a network-open one mounts `/tmp` writable) can replace the file without effect.
For any other path the wrap binds the filter's directory read-only, or the file where the directory
is a writable root or contains one. That is only a partial fix: the bind guards the file only from
the command that loads it, a temp dir nested inside a writable root can still be swapped by renaming
an ancestor, and where only the file is bound its parent can be renamed. Code that reads the
helper's file itself is not covered either.

The piped wrap passes the program, bubblewrap's arguments and the command to `/bin/sh` as
positional arguments, so each is shell-escaped once. Every sandbox wrap also writes a backslash that
precedes a quote, a backslash or the end of a word outside the single quotes, so the wrap parses to
the same words under fish as under sh. Before, when the PTY's `$SHELL` was fish, a command containing
`\'` could end the quoting early and run its tail in the host shell, outside bubblewrap.
