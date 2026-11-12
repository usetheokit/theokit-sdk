---
"@theokit/sdk": patch
---

An API key shorter than 4 characters is no longer refused for a custom provider the SDK cannot attribute (for example one from `Provider.create`). Only empty and whitespace-only keys are rejected there; keys for built-in `api_key` providers keep the strict shape check.
