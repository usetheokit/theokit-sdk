---
"@theokit/sdk": major
---

The `network` option of `LinuxSandbox` and `createSandboxBackend` widens from `boolean` to `boolean | { allow }`, so the declarations of `LinuxSandbox`, `CreateSandboxBackendOptions` and `wrapCommandForSandbox` change. Existing `true`/`false` callers are unaffected; code that reads the option's type as `boolean` must handle the object form.
