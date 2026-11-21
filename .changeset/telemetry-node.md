---
"@theokit/sdk": minor
---

New optional sub-path `@theokit/sdk/telemetry-node` with `registerTelemetry`, which registers global OTLP/HTTP tracer and meter providers (plus an optional loopback Prometheus endpoint) for `AgentOptions.telemetry`. Export errors are redacted and masked before they reach `onExportError`. The OpenTelemetry SDK and exporter packages are optional peers.
