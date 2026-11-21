---
"@theokit/sdk": patch
---

`registerTelemetry` strips trailing slashes from `endpoint` with a linear scan instead of a regular expression that could run slowly on long runs of `/`.
