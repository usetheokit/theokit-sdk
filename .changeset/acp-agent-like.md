---
"@theokit/acp": minor
---

`serveAcp` now accepts any `AgentLike` (or a factory returning one) instead of requiring a full `SDKAgent`; `dispose` is optional, and `session/new` now fails closed with `permission_enforcement_unavailable` when `ask`/`deny` cannot be enforced (#1019).
