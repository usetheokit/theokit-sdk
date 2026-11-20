---
"@theokit/sdk": minor
---

A2A: `sealedTransport` wraps an `A2ATransport` with end-to-end encryption (X25519, HKDF-SHA256, AES-256-GCM) and sender authentication against `trustedPeers`, with replay protection via `memorySequenceStore` / `jsonSequenceStore`, `generateA2AIdentity`, and `A2AUntrustedPeerError` (#1051).
