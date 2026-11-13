---
"@theokit/cli": patch
---

`theokit inspect` now lists plugins with the SDK's `listWorkspacePlugins`, so it shows exactly what an agent started in the same directory would load: no more `~/.theokit/plugins`, and `.claude-plugin/plugin.json` plugins are recognised. The plugin entries drop `description` and the `user-global` source, and gain `format`.
