---
"@theokit/cli": patch
---

`theokit inspect` now lists plugins by calling the SDK's `listWorkspacePlugins`, so it shows exactly what an agent started in the same directory would load. It no longer lists `~/.theokit/plugins` (the runtime never reads it), and it recognises `.claude-plugin/plugin.json` and `plugin.json` manifests. Plugin entries no longer carry `description`, and `source` is always `project`.
