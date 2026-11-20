---
"@theokit/sdk": patch
---

Deprecate `@theokit/sdk/server/errors-envelope` (`toEnvelope`, `fromEnvelope`, `TheokitErrorCode`, `TheokitErrorEnvelope`). It keeps working, and will be removed in the next major. Read `name`, `isRetryable` and `metadata` from the error to build your own envelope; theokit apps get the envelope from `theokit/server`.
