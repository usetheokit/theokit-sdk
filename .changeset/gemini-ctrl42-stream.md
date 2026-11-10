---
'@theokit/sdk': patch
---

Streaming no longer emits Gemini's `<ctrl42>call print(default_api.<tool>(...))` text as `text_delta` for a declared tool; the call is recovered when the stream ends.
