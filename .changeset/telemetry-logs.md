---
"@theokit/sdk": major
---

`registerTelemetry` accepts a `logExporter` (new optional peer `@opentelemetry/sdk-logs`) and returns a `log` function that emits records through it, beside the trace and metric providers. Without a log exporter `log` is a no-op.
