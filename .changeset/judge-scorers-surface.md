---
"@theokit/sdk": major
---

The `Scorers` object gains `faithfulness`, `rubric` and `judgedTrajectory`, and the `Scorer` type gains an optional `context` argument. The api-surface gate counts any change to these stable declarations (and to `SandboxBackend`, which gained `uploadFiles`) as breaking; existing callers are unaffected.
