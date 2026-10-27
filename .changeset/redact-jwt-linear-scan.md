---
'@theokit/sdk': patch
---

`Security.redact` (and `redactSecrets` on the `@theokit/sdk/internal/security` subpath) no longer
blocks the event loop on a long run of `eyJ` it cannot complete as a JWT. The JWT pattern was a regex
that retried from every `eyJ` of such a run, so its time grew with the square of the run: 224000
characters of `eyJa` took over two minutes, and a string half filled by that run 20 to 40 seconds.
Callers that redact unbounded text, such as the session transcript, span attributes or a provider
error body, stalled for that long. JWTs are now found by a scan that reads each run of characters at
most three times, and the same inputs return in under 100 ms. What gets masked, and how, is
unchanged.
