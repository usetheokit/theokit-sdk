---
"@theokit/sdk": major
---

Auth: add `startSignInWeb` and `finishSignInWeb` (Web `Request` / `Headers`) to the orchestrator, export `writeTransactionCookie`, `readTransactionCookie` and `clearTransactionCookie` from `@theokit/sdk/server/auth`, widen `AuthProvider.handleCallback` to `Request | IncomingMessage`, and add an optional `SessionManager.createSessionWeb`.
