---
"@theokit/sdk-memory": patch
---

Memory search no longer comes back empty when the FTS query fails with this package installed. `IndexManager` here was an older copy of the one in `@theokit/sdk` and answered a failed FTS query with no hits; it is now the SDK's class, which falls back to a LIKE scan and reports the fallback on the diagnostics sink when the query is not CJK. `Memory.openIndex` therefore searches the same way with or without this package.

The backend dispatch, `LanceIndex`, `migrateSqliteToLance` and `migrateLegacyJson` are re-exported from the SDK as well, and behave as they do there:

- `sync()` results carry `supported`, and `status()` carries `countsExact`.
- `LanceMemoryAdapter` extends the SDK's adapter and adds only `unwrap()`. Its `search()` blends the vector score with a term-overlap text score through `vectorWeight` and `textWeight`, so `score` is no longer the bare vector score, and its `sync()` reports `supported: false`. An index opened with `IndexManager.open({ backend: "lance" })` is the SDK's adapter, which has no `unwrap()`.
- `migrateSqliteToLance` refuses a `batchSize` that is not a whole number of at least 1 (`invalid_batch_size`).
- `migrateLegacyJson` reports on the diagnostics sink instead of writing to stderr, and shares one per-process set of migrated keys with the SDK.
