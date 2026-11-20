---
"@theokit/sdk": patch
---

Tests: the real-LLM OpenRouter fallback is now checked end to end, so an anthropic suite run with only OPENROUTER_API_KEY set sends its request to OpenRouter instead of failing with malformed_api_key.
