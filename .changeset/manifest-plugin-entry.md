---
"@theokit/sdk": minor
---

The manifest plugin entry of a trusted workspace plugin folder is now imported. A folder under `<cwd>/.theokit/plugins/<folder>/` whose `PLUGIN.md` names an `entry` used to be listed by `agent.plugins.list()` and never imported, so the tools its `register` adds never reached a run. With `local.settingSources` including `"plugins"`, `Agent.create` now imports that entry and registers its default export, which must be a `kind: "general"` plugin, alongside `AgentOptions.plugins`.

Trust is by the folder's absolute realpath, in a trust record of its own: `~/.theokit/plugins/trusted-workspace-plugins.json`, a JSON array of folder realpaths, read on every `Agent.create`. The provider trust list (`trusted-providers.json`, `THEOKIT_TRUSTED_PROVIDERS`) does not authorize a workspace folder, so a repository you cloned cannot get its code run by naming a folder after a provider you trust. A relative entry is discarded with a warning, and a record that is not a valid JSON array trusts nothing. An untrusted folder is listed, never imported, and diagnosed once per process with the realpath to add. Plugins found under a foreign root (`compatSources`, such as `.claude/plugins`) are never imported, and neither `agent.reload()` nor a manifest without an `entry` imports anything. A changed entry needs a process restart, since Node caches the module.

The provider trust gate is now read on every `Agent.create` too: a provider plugin trusted between two creates is imported by the second, and each provider is still imported at most once per process. The untrusted-provider warning no longer says to restart.

A trusted entry that cannot be used fails `Agent.create` with a `ConfigurationError` naming the plugin: `plugin_entry_import_failed` when the module throws on import (the thrown error is the `cause`), and `plugin_entry_shape` when its default export is not a general plugin with a `name` and a `register` function.
