---
"@theokit/sdk": minor
---

Add `hookFingerprint`, `fingerprintHookGate` and `listProjectHooks` (with the `ProjectHook` type) from `@theokit/sdk` (also the `@theokit/sdk/hooks-approval` sub-entry), so a consumer can list the command hooks a project declares, fingerprint them, and gate them by an allowlist without re-implementing the SDK's file set or timeout default. A malformed fingerprint is rejected with `hook_fingerprint_invalid`.
