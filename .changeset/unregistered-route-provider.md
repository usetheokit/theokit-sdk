---
"@theokit/sdk": patch
---

A route whose provider names no registered profile now fails the run with a message that says so. With `providers.routes: [{ capability: "chat", provider: "no-such-provider" }]`, the run used to end with a `ConfigurationError` telling you to set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` / `OPENROUTER_API_KEY`, even when a key was set. The message now reads `No provider client could be resolved: "no-such-provider" is not a known provider. Registered providers: …`, with the registered names sorted. A provider that a plugin registered is listed too. The class (`ConfigurationError`), the code (`provider_unresolved`) and the opening phrase `No provider client could be resolved` are unchanged, and a registered provider with no key still gets the credentials message, word for word.
