---
"@theokit/sdk": minor
---

`agent.send(message, { toolDecisions })` resumes deferred tool calls, also after a process restart. `toolDecisions` takes one `allow` or `deny` per pending `toolUseId`, read from the stored transcript: an `allow` runs the stored call after the permission rules, floors and hooks run again (an approval never overrides a deny), a `deny` writes an error result. Unknown or repeated ids, missing decisions and unsupported `schemaVersion`s reject with `ConfigurationError` and leave the session unchanged. A normal send while calls are pending abandons them so the session is not blocked.
