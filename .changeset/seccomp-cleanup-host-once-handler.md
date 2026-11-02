---
'@theokit/sdk': patch
---

The seccomp temp-dir cleanup of `seccompPathForArch` and `restrictedSeccompPath` no longer cuts off a host's shutdown handler registered with `process.once`: it runs first, removes its directory, and leaves the ending to the host. The directory is now gone before the host's handler starts; a process with no handler of its own still ends by the signal.
