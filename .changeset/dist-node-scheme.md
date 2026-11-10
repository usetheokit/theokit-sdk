---
'@theokit/sdk': patch
---

packaging: keep the `node:` scheme on builtin imports in `dist` (`node:readline/promises`), so esbuild bundles resolve it as a builtin.
