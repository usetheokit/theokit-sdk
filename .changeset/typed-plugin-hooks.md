---
"@theokit/sdk": minor
---

Plugin hook handlers are now typed by hook name: `PluginContext.on` infers the context and checks the return value (e.g. a `pre_tool_call` veto). Adds `HookContextMap`, `HookResultMap`, `TypedHookHandler` and `GeneralPlugin`; `HookHandler` is exported and handlers typed `(ctx: unknown) => unknown` still compile (#1033).
