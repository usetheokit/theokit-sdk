---
"@theokit/sdk": patch
---

Security.redact now masks Stripe `whsec_`, `sk_test_` and `rk_test_` tokens and the password in `scheme://user:password@host` URLs. Publishable keys stay visible.
