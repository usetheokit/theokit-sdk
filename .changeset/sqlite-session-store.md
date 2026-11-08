---
"@theokit/sdk": minor
---

New `SqliteSessionStore` (exported from `@theokit/sdk` and `@theokit/sdk/persistence`): a `SessionStore` backed by one SQLite file, passed as `local.sessionStore`. `Agent.transcript`, `injectSessionTurn` and `compact` now read from the agent's configured `local.sessionStore` instead of always opening the JSONL file.
