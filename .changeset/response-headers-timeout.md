---
'@theokit/sdk': patch
---

llm: bound the wait for response headers (default 30 s, `responseHeadersTimeoutMs`, `<= 0` disables); a stalled request now fails with a retryable `NetworkError` (`response_headers_timeout`) instead of waiting for undici's 300 s.
