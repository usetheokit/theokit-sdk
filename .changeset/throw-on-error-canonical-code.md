---
'@theokit/sdk': patch
---

README "Failed runs" states that under `throwOnError` the canonical error code is `err.metadata?.code ?? err.code`, since a provider-mapped `err.code` can be prefixed.
