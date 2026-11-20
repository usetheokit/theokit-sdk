---
"@theokit/sdk": patch
"@theokit/sdk-memory": minor
---

Breaking: removed `resetMigrationStateForTests` from the root entry. It was a test helper; `migrateLegacyJson` and `MigrationResult` are still exported.
