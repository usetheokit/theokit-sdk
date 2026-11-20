---
"@theokit/sdk": major
---

Remove two surfaces that were never meant for consumers.

- `__resetSnapshotStoresForTests` is no longer exported from `@theokit/sdk/workflow`. It was a test-only helper with no supported use; there is no replacement. Create workflows with unique ids instead of resetting the shared snapshot store.
- The deprecated `@theokit/sdk/internal/persistence` subpath is removed. Import `atomicWriteJson`, `atomicWriteText`, `replaceFileAtomic`, `withCwdMutex`, `withFileLock`, `sanitizeFts5Query`, `PersistenceSchema` and the other supported primitives from `@theokit/sdk/persistence`. Internal-only primitives (`createExclusive`, `casUpdate`, `getTheokitHome`, `containsCjk` and similar) have no public replacement.
