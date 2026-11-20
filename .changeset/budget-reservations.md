---
"@theokit/sdk": minor
---

Add `Budget.reserve(name, estimatedUsd)`: in-flight estimates are held against a budget, so concurrent calls can no longer overrun a `block` budget. `preflightCheck` counts open holds, the returned `BudgetReservation` has `settle(actualUsd)` and `release()`, and `BudgetSnapshot` gains `heldUsd`.
