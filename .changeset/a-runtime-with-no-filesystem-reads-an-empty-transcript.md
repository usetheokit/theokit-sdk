---
'@theokit/sdk': patch
---

A session transcript read on a runtime with no filesystem continues with an empty transcript instead
of failing the turn.

`readTranscript` treated only `ENOENT` as "there is no transcript yet" and rethrew everything else.
That is right for a real filesystem, where any other code is a genuine fault. On Workers there is no
filesystem at all, and `unenv`'s `createNotImplementedError` throws a plain `Error` carrying **no**
`code` — so the guard missed it and a turn died on a read whose only purpose is to recover history
that does not exist.

Measured on a deployed worker (theokit#705):

    agent turn failed (SDK_ERROR): [unenv] fs.readFile is not implemented yet!

A codeless error inside a `try` that wraps only the `readFile` is a precise discriminator rather than
a catch-all: every real filesystem failure carries a code (`EACCES`, `EISDIR`, `EMFILE`), so nothing
that a filesystem can produce is swallowed by it. The absence of a code means the call never reached
a filesystem, which is the one case where an empty transcript is the correct answer. It is reported
through `diag`, so an operator who turns diagnostics on sees why the history is empty.
