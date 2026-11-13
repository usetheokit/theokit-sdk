---
"@theokit/sdk": minor
---

`DiscoverySpec.pattern` accepts a list of filenames (first match per directory) for `cwd-only` and `git-root-walk`, and `runDiscovery` takes `wrapImport` to wrap each inlined `@import`. A file discovery already loaded is no longer inlined again by an import (placeholder `[@import already loaded: ...]`). A list on a `globbed` spec throws `ConfigurationError`.
