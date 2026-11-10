---
'@theokit/sdk': patch
---

When a route sets `extractToolCallsFromContent`, tool-call repair recovers Gemini's text-form calls (`<ctrl42>call` / `print(default_api.tool(...))`) for declared tools, so the turn runs them instead of ending with the code as its answer.
