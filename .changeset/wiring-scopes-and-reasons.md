---
"@theokit/sdk": major
---

`recordWiring` records each entity's scope (`scopes` input, `entities` output) and why a capability is off (`disabled` input, `off` output: `suppressed-by-trust`, `disabled-by-config` or a caller-defined reason). New `offCapabilities(record)` lists the capabilities that are off with their reasons.
