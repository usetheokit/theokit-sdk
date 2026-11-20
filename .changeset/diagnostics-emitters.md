---
"@theokit/sdk": minor
---

Export `diag` and `diagFailure` so packages above the SDK can send to the host's diagnostics sink. The functions are unchanged; the SDK does not redact the message.
