---
"@theokit/sdk": minor
---

sandbox: `network: { allow, credentials }` injects credentials at the egress proxy. The sandbox gets only a placeholder (and optionally an env var set to it); the proxy swaps in the real value from `value()` for the rule's host, terminating TLS with a per-proxy in-memory CA for those hosts only. A placeholder sent to another host is refused as `credential_misroute`, and a rule for a host no `EgressRule` allows throws `ConfigurationError` `credential_host_not_allowed`. Exports `CredentialRule`.
