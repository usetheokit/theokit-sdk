---
'@theokit/sdk': patch
---

The seccomp temp-dir cleanup of `seccompPathForArch` and `restrictedSeccompPath` no longer cuts off a host's shutdown handler registered with `process.once`: it runs first, removes its directory, and leaves the ending to the host. The directory is now gone before the host's handler starts; a process with no handler of its own still ends by the signal. One order is not covered: a host that itself prepends a `once` handler (`process.prependOnceListener`) after the first sandboxed command runs before the cleanup and is not counted, so the signal is raised again while its shutdown runs.
