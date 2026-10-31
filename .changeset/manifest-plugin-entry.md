---
"@theokit/sdk": minor
---

The manifest plugin entry of a trusted workspace plugin folder is now imported. A folder under `<cwd>/.theokit/plugins/<folder>/` whose `PLUGIN.md` names an `entry` used to be listed by `agent.plugins.list()` and never imported, so the tools its `register` adds never reached a run. With `local.settingSources` including `"plugins"`, `Agent.create` now imports that entry and registers its default export, which must be a `kind: "general"` plugin, alongside `AgentOptions.plugins`.

Trust is by folder name, through the existing provider trust gate: `~/.theokit/plugins/trusted-providers.json` (a JSON array of names) or `THEOKIT_TRUSTED_PROVIDERS` (comma-separated). It is the same list provider plugins use, so a name trusted as a model provider also trusts a workspace folder of that name, including one in a repository you cloned. An untrusted folder is listed, never imported, and diagnosed once per process. Plugins found under a foreign root (`compatSources`, such as `.claude/plugins`) are never imported, and neither `agent.reload()` nor a manifest without an `entry` imports anything. A changed entry needs a process restart, since Node caches the module.

The trust gate is now read on every `Agent.create`, by provider discovery too: a provider plugin trusted between two creates is imported by the second, and each provider is still imported at most once per process. The untrusted-provider warning no longer says to restart.

This is a change in behaviour for a workspace that already has a trusted folder whose manifest names an entry: that entry used to be ignored and now runs. A trusted entry that cannot be used fails `Agent.create` with a `ConfigurationError` naming the plugin: `plugin_entry_import_failed` when the module throws on import (the thrown error is the `cause`), and `plugin_entry_shape` when its default export is not a general plugin with a `name` and a `register` function.
