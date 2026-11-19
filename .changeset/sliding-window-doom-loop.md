---
"@theokit/sdk": minor
---

Add `window` and `windowRepeatLimit` to `DoomLoopThresholds`: a sliding-window repeat limit that blocks identical tool calls (same tool, same arguments) which alternate with others, so A-B-A-B loops no longer slip past the consecutive-only guard (#1031).
