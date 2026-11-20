---
"@theokit/sdk": minor
---

`@theokit/sdk/eval`: a `Scorer` now receives a `ScoreContext` (input, metadata and the run's `toolCalls`) as its third argument, and `Scorers.toolCallAccuracy` and `Scorers.trajectory` score the tools a run called (#1103).
