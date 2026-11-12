---
"@theokit/acp": patch
---

fix(acp): a tool that failed now reaches the host as `failed` instead of `completed`, because the SDK now reports `status: "error"` for it
