---
"@theokit/sdk": patch
---

A `thinking` entry in `model.params` with an empty value is now refused instead of silently
turning reasoning off. `Agent.create` and a `send` model override throw a `ConfigurationError` with
code `invalid_model_param` before any request when the `thinking` value is empty, whitespace only,
missing or not a string, and the message names the param. It used to be accepted, and the chat
request went out with neither `reasoning_effort` nor `reasoning`, so a UI filling the value from an
unset setting lost reasoning with no signal. To request no reasoning, leave the `thinking` param
out. A non-empty value such as `"high"` is forwarded as before.
