---
'@theokit/sdk': patch
---

The unknown-provider error lists the registered provider names in locale order instead of UTF-16 code
unit order, so a mixed-case name such as `alpha` is no longer listed after `Zeta`. Builtin names are
lowercase ASCII, so their order does not change.
