---
"@theokit/sdk": minor
---

Add `parsePluginManifest`, `trustWorkspacePlugin`, `untrustWorkspacePlugin` and `installWorkspacePlugin` to parse a `PLUGIN.md`, and to install and trust a workspace plugin without editing the trust record by hand. A trust record that cannot be parsed throws `TrustRecordError` and is never overwritten; a bad manifest throws `PluginManifestError`.
