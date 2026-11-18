---
"@theokit/sdk": minor
---

Add `readManagedSettingsDocument(root?, { onWarn? })` to the root entry. It returns the whole parsed `managed-settings.json` (`{ path, raw }`) so an app can read its own operator-imposed keys. An unreadable, invalid or non-object file returns `null` and warns through `onWarn` (default `diagFailure`).
