---
"@theokit/sdk": patch
---

Two throwable error codes are back in the published error reference.

`subagent_foreign_runtime_field` and `subagent_unknown_field` were written as a ternary inside the
`ConfigurationError` options. `tools/generate-error-codes.mjs` walks the source for the literal
assigned to `code:`, and a ternary is not a literal, so it extracted NEITHER — the reference lost a
code it used to list and never gained the one that replaced it.

Both are real and both are thrown. The error reference is the one place a consumer looks to find
out what they can catch, and it listed neither.
