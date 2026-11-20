---
"@theokit/sdk": minor
---

Add `@theokit/sdk/telemetry-node` with `registerTelemetry`, which registers global OTLP/HTTP tracer and meter providers (optional loopback Prometheus endpoint, redacted export-error lines, non-rejecting `shutdown`). The OpenTelemetry SDK packages are optional peers loaded lazily (#1044).
