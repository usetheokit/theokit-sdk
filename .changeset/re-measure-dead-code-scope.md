---
"@theokit/sdk": patch
---

The dead-code scope note carries a second measurement. It said declaring all twelve packages "was
measured on 2026-08-20 and surfaced nothing", which is the honest shape for a coverage gap — but a
note like that stays true only while its number does. Re-measured 2026-09-15 by declaring the other
ten workspaces and running knip: configuration hints only, no unused exports, exit 0. The ten are
still unexamined rather than known-dirty, now on two dates instead of one.
