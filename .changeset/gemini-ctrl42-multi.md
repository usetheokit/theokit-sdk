---
'@theokit/sdk': patch
---

llm: recover several `print(default_api.<tool>(…))` calls under one Gemini `<ctrl42>call` marker (calls to undeclared tools stay text), and name the recovered format in the diagnostic.
