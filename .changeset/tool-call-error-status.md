---
"@theokit/sdk": minor
---

feat(sdk): a tool call that finishes with a non-zero `exitCode` (a thrown handler, a timeout, a veto, an unknown tool) is now emitted with `status: "error"` instead of `"completed"`. Consumers that match `status === "completed"` for any finished call should also accept `"error"`.
