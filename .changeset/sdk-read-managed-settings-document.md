---
"@theokit/sdk": minor
---

Add `readManagedSettingsDocument(root?, { onWarn? })`, which returns the whole parsed `managed-settings.json` (`{ path, raw }`) so an app can read its own operator-imposed keys. An unreadable, invalid or non-object file returns `null` and warns through `onWarn` (default `diagFailure`).
