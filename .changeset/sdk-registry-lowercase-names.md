---
'@theokit/sdk': patch
---

`registerProvider` lowercases a profile's name and aliases, and `getProviderProfile` looks names up
in lowercase, so a profile registered as `AcmeAI` with alias `AcmeX` is reached by routes naming
either. This replaces the router's "register it in lowercase" errors for mixed-case names and
aliases (their two tests now assert routing instead), since such a registration can no longer occur.
