---
"@theokit/sdk": patch
---

`PermissionEngine` now throws `ConfigurationError` (`permission_rules_not_array` / `permission_rule_invalid`) at construction when given a non-array or a malformed rule, instead of failing later in `evaluate`.
