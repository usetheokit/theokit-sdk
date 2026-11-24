---
"@theokit/sdk": minor
---

`agentOptionsFromDefinition(def, parent)` and `SubagentParent` are exported from `@theokit/sdk/a2a`: they build `Agent.create` options for an `AgentDefinition` under a parent (credential, model, tools whitelist, withheld builtins, plugins, setting sources). `Squad.create` takes an optional `parent` and builds definition members through it; a definition that sets `tools`, `withheldBuiltinTools` or `sandbox` without a `parent` is refused (`squad_definition_scope_needs_parent`). `AgentDefinition` gains `withheldBuiltinTools`, unioned with the parent's.
