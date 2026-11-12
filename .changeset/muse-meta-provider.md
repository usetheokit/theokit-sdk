---
"@theokit/sdk": minor
---

Add a `meta/<model>` provider that runs turns through Meta's Muse Code CLI (`muse serve`) over the Muse Session Protocol. Muse owns the loop and sandbox; tool approvals pass through the caller. A missing `muse` binary or a missing sign-in raises a typed error.
