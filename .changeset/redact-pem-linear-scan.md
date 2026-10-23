---
"@theokit/sdk": patch
---

`redactSecrets` no longer stalls on text that holds many PEM `BEGIN ... PRIVATE KEY` headers with no matching `END` header. Such input used to take seconds for a few hundred KB, because the PEM pattern searched to the end of the string once per header; PEM blocks are now found in one linear pass, so the same input takes milliseconds. What gets masked is unchanged.
