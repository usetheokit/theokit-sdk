---
"@theokit/sdk": patch
---

fix(sdk): a model prefix naming a custom provider (or a bare `sk-` key) no longer gets overruled by key inference, so prompts and keys stay with the provider the app configured
